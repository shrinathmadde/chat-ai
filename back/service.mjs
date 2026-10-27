// Import modules
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";          
import fileUpload from "express-fileupload";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { Readable } from "stream"; // Node's stream module
import OpenAI from "openai";

const app = express();

// Path to the external config file
const CONFIG_LOCATION = process.env.CONFIG_LOCATION || "../secrets/back.json";
const configPath = path.resolve(CONFIG_LOCATION);

// Default configuration if config file is missing or invalid
let port = 8081;
let apiEndpoint = "https://chat-ai.academiccloud.de/v1";
let apiKey = "";
let serviceName = "Chat AI Dev";
// Optional access rules on the OIDC claims the SSO proxy adds as headers:
// { org: rule, organization: rule, user: rule }, each rule being
// { whitelist: [], blacklist: [] }. Every configured rule must pass.
let userFilter = {};
// Users (uid or email) that skip all rules
let adminUsers = [];
let radiologyServiceUrl = "";
// Optional model ids: { whitelist: [], blacklist: [] }. With a whitelist only
// those models are listed and accepted; blacklisted models never are.
let modelWhitelist = [];
let modelBlacklist = [];

// Load configuration
try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (typeof config.port === "number" && config.port > 0) {
    port = config.port;
    console.log("Port:", port);
  } else {
    console.warn(
      "Invalid port in back.json. Falling back to default port 8081."
    );
  }
  apiEndpoint = config.apiEndpoint;
  apiKey = config.apiKey;
  serviceName = config.serviceName;
  if (config.userFilter && typeof config.userFilter === "object") {
    userFilter = config.userFilter;
  }
  adminUsers = normalizeList(config.adminUsers);
  radiologyServiceUrl = config.radiologyServiceUrl || "";
  modelWhitelist = normalizeList(config.modelFilter?.whitelist);
  modelBlacklist = normalizeList(config.modelFilter?.blacklist);
  console.log(
    "Model filter:",
    modelWhitelist.length ? `only ${modelWhitelist.join(", ")}` : "no whitelist",
    modelBlacklist.length ? `| never ${modelBlacklist.join(", ")}` : "| no blacklist"
  );
} catch (error) {
  console.error("Failed to read back.json. Using default values.", error);
}

// Global request limitations
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));
app.use(
  fileUpload({
    createParentPath: true,
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB max file size
    },
    debug: false,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((err, req, res, next) => {
  if (err.name === "FileUploadError") {
    console.error("File Send Error:", err);
    return res.status(400).json({ error: err.message });
  }
  next(err);
});
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());

// User identity from the OIDC headers set by the SSO proxy; empty without one
function getUserFromHeaders(req) {
  return {
    email: req.headers["oidc_claim_email"] || "",
    firstname: req.headers["oidc_claim_given_name"] || "",
    lastname: req.headers["oidc_claim_family_name"] || "",
    org: req.headers["oidc_claim_o"] || "",
    organization: req.headers["oidc_claim_ou"] || "",
    username: req.headers["oidc_claim_uid"] || "",
  };
}

function normalizeList(list) {
  return Array.isArray(list)
    ? list.map((v) => String(v).trim().toLowerCase()).filter(Boolean)
    : [];
}

// Claims with several values may arrive comma or semicolon separated
function splitClaim(value) {
  return normalizeList(String(value).split(/[,;]/));
}

// A rule fails if any value is blacklisted, or if it has a whitelist and no
// value is on it. Requests without OIDC headers therefore fail any whitelist.
function passesRule(values, rule) {
  if (!rule) return true;
  const whitelist = normalizeList(rule.whitelist);
  const blacklist = normalizeList(rule.blacklist);
  if (values.some((v) => blacklist.includes(v))) return false;
  return whitelist.length === 0 || values.some((v) => whitelist.includes(v));
}

function isAllowed(user) {
  const ids = normalizeList([user.username, user.email]);
  if (ids.some((id) => adminUsers.includes(id))) return true;
  return (
    passesRule(splitClaim(user.org), userFilter.org) &&
    passesRule(splitClaim(user.organization), userFilter.organization) &&
    passesRule(ids, userFilter.user)
  );
}

// Reject users the access rules don't allow, before any route runs
app.use((req, res, next) => {
  if (isAllowed(getUserFromHeaders(req))) return next();
  return res.status(403).json({ error: "Access denied." });
});

// Whether modelFilter allows a model id: on the whitelist if there is one, and
// not on the blacklist. Ids are compared case-insensitively.
function isAllowedModel(id) {
  const key = String(id ?? "").trim().toLowerCase();
  if (modelWhitelist.length > 0 && !modelWhitelist.includes(key)) return false;
  return !modelBlacklist.includes(key);
}

// A request that runs a model outside modelFilter is refused. The model list
// already leaves those models out, but a request can still name one: an old
// conversation, shared settings, a direct call.
function requireAllowedModel(req, res, next) {
  if (modelWhitelist.length === 0 && modelBlacklist.length === 0) return next();
  const model = req.body?.model;
  if (typeof model === "string" && isAllowedModel(model)) return next();
  return res.status(403).json({
    error: `The model ${model} is not available here. Please choose another model.`,
  });
}

// Function to process file with docling
async function processFile(file, inference_id) {
  const url = apiEndpoint + "/documents/convert/file";
  const formData = new FormData();
  formData.append("files", file.data, {
    filename: file.name,
    contentType: file.mimetype,
  });
  formData.append("extract_tables_as_images", "false");
  formData.append("image_resolution_scale", "4");
  formData.append("image_export_mode", "placeholder");
  formData.append("to_formats", "md");
  formData.append("pdf_backend", "dlparse_v4");
  formData.append("include_images", "false");
  
  const headers = {
    "inference-portal": serviceName,
  };

  // Only add Authorization header if apiKey is present and non-empty
  if (apiKey) {
    headers.Authorization = "Bearer " + apiKey;
  } else {
    // Only add inference-id header if apiKey is empty or non-existent
    headers["inference-id"] = inference_id;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: formData,
  });
  if (response.status !== 200) console.log(response.text);
  console.log(response.status)
  return response;
}

// Process PDF file
app.post("/documents/convert/file", async (req, res) => {
  // Check for the presence of `document` file key
  if (!req.files || !req.files.document) {
    return res.status(422).json({ error: "No file provided" });
  }

  const inference_id = req.headers["inference-id"];
  try {
    // Access the file using the correct key name
    const file = req.files;
    const response = await processFile(file, inference_id);
    if (!response.ok) {
      return res.status(response.status).send(response.statusText);
    }
    const result = await response.json();
    return res.status(200).json(result);
  } catch (err) {
    console.error("Processing error:", err);
    return res.status(500).json({
      error: "An internal server error occurred while processing file",
    });
  }
});

// Get list of models, only the ones modelFilter allows
app.get("/models", async (req, res) => {
  try {
    const url = apiEndpoint + "/models";
    const inference_id = req.headers["inference-id"];
    const headers = {
      Accept: "application/json",
      Authorization: "Bearer " + apiKey,
      "inference-portal": serviceName,
    };
    if (apiKey) {
      headers.Authorization = "Bearer " + apiKey;
    } else {
      // Only add inference-id header if apiKey is empty or non-existent
      headers.Authorization = "Bearer " + inference_id;
    }
    const response = await fetch(url, { method: "GET", headers });
    // The upstream can answer with an error body instead of the list
    const body = await response.json();
    if (Array.isArray(body?.data)) {
      body.data = body.data.filter((model) => isAllowedModel(model.id));
    }
    res.status(200).json(body);
  } catch (error) {
    console.error(`Error: ${error}`);
    res.status(500).json({ error: "Failed to fetch models." });
  }
});

// Get user data from the OIDC headers, or placeholder data without SSO
app.get("/user", async (req, res) => {
  try {
    const user = getUserFromHeaders(req);
    if (user.username) return res.status(200).json(user);
    res.status(200).json({
      email: "user@example.com",
      firstname: "Sample",
      lastname: "User",
      org: "GWD",
      organization: "GWDG",
      username: "sample-user",
    });
  } catch (error) {
    console.error(`Error: ${error}`);
    res.status(500).json({ error: "Failed to fetch user info." });
  }
});

// Speech generation endpoint
app.post("/audio/speech", async (req, res) => {
  // Simply forward the request and return response
  try {
    const url = apiEndpoint + "/audio/speech";
    const inference_id = req.headers["inference-id"];
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
      "inference-portal": serviceName,
    };
    if (apiKey) {
      headers.Authorization = "Bearer " + apiKey;
    } else {
      // Only add inference-id header if apiKey is empty or non-existent
      headers.Authorization = "Bearer " + inference_id;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(req.body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Speech generation failed:", response.status, errorText);
      return res.status(response.status).json({ error: errorText });
    }
    const arrayBuffer = await response.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error("Error in speech generation endpoint:", error);
    res.status(500).json({ error: "Failed to generate speech." });
  }
});

// Speech-to-text endpoint: forwards an uploaded recording and returns { text }.
// Recordings are dictations with patient data, so neither the audio nor the
// transcript is logged.
app.post("/audio/transcriptions", async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(422).json({ error: "No audio file provided" });
  }
  try {
    const url = apiEndpoint + "/audio/transcriptions";
    const inference_id = req.headers["inference-id"];
    const file = req.files.file;
    const formData = new FormData();
    formData.append("file", file.data, {
      filename: file.name,
      contentType: file.mimetype,
    });
    for (const field of ["model", "language"]) {
      if (req.body[field]) formData.append(field, req.body[field]);
    }
    formData.append("response_format", "json");

    const headers = {
      Authorization: "Bearer " + (apiKey ? apiKey : inference_id),
      "inference-portal": serviceName,
    };
    const response = await fetch(url, { method: "POST", headers, body: formData });
    if (!response.ok) {
      console.error("Transcription failed:", response.status);
      return res.status(response.status).json({ error: await response.text() });
    }
    // The upstream can answer 200 with an error body, so check for the text
    const result = await response.json();
    if (typeof result?.text !== "string") {
      console.error("Transcription returned no text");
      return res.status(502).json({ error: "Unexpected transcription response" });
    }
    res.status(200).json({ text: result.text });
  } catch (error) {
    console.error("Error in transcription endpoint:", error.message);
    res.status(500).json({ error: "Failed to transcribe audio." });
  }
});

// Radiology report pipeline (modules.radiology): forwards the inputs to the
// parser service (parser/app.py) and returns { report, edit_log, sections, usage,
// assessment_generated }.
// The inputs are patient data, so neither the request nor the report is logged.
// The service bounds its own model calls (2 attempts × 10 min); this timeout
// only catches a service that hangs.
const RADIOLOGY_TIMEOUT_MS = 25 * 60 * 1000;

app.post("/radiology/report", requireAllowedModel, async (req, res) => {
  if (!radiologyServiceUrl) {
    return res.status(503).json({
      error: "The report pipeline is not configured (radiologyServiceUrl in back.json).",
    });
  }
  // reasoning: the thinking settings, as sent with a normal chat completion
  const { previous_report, dictation, assessment, model, reasoning } = req.body;
  try {
    const response = await fetch(radiologyServiceUrl + "/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previous_report, dictation, assessment, model, reasoning }),
      signal: AbortSignal.timeout(RADIOLOGY_TIMEOUT_MS),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Report pipeline failed:", response.status);
      // FastAPI puts its message in `detail` (a list for malformed requests)
      const error = typeof result.detail === "string"
        ? result.detail
        : `The report pipeline failed (${response.status}).`;
      return res.status(response.status).json({ error });
    }
    res.status(200).json(result);
  } catch (error) {
    console.error("Error in report pipeline endpoint:", error.name);
    res.status(502).json({
      error: error.name === "AbortError"
        ? "The report pipeline timed out."
        : "The report pipeline is unreachable.",
    });
  }
});

// Report feedback (modules.radiologyFeedback): a report the radiologist chose
// to share for evaluation, with its inputs, both versions and their comments,
// or the withdrawal of one by its id. The parser service stores it (only while
// radiologyFeedbackPath is set in back.json). Nothing about the user is added,
// and the content is not logged.
async function forwardFeedback(res, method, path, body) {
  if (!radiologyServiceUrl) {
    return res.status(503).json({
      error: "The report pipeline is not configured (radiologyServiceUrl in back.json).",
    });
  }
  try {
    const response = await fetch(radiologyServiceUrl + "/feedback" + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30 * 1000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Report feedback failed:", response.status);
      const error = typeof result.detail === "string"
        ? result.detail
        : `Storing the feedback failed (${response.status}).`;
      return res.status(response.status).json({ error });
    }
    res.status(200).json(result);
  } catch (error) {
    console.error("Error in report feedback endpoint:", error.name);
    res.status(502).json({ error: "The report pipeline is unreachable." });
  }
}

app.post("/radiology/feedback", (req, res) =>
  forwardFeedback(res, "POST", "", req.body)
);

app.delete("/radiology/feedback/:id", (req, res) =>
  forwardFeedback(res, "DELETE", "/" + encodeURIComponent(req.params.id))
);

// Chat Completions API
app.post("/chat/completions", requireAllowedModel, async (req, res) => {
  const {
    messages,
    model,
    temperature = 0.5,
    top_p = 0.5,
    arcana = null,
    timeout = 30000,
    enable_tools = null,
    tools = null,
    stream = true,
    feedback = null,
    chat_template_kwargs = null,
    reasoning_effort = null,
  } = req.body;

  const mcp_servers = req.body["mcp-servers"] || null;
  const inference_id = req.headers["inference-id"];
  const uid = req.headers["oidc_claim_uid"];
  if (!Array.isArray(messages)) {
    return res.status(422).json({ error: "Invalid messages provided" });
  }

  const validatedTimeout = Math.min(Math.max(timeout, 5000), 900000);
  let inference_service;
  let params;

  try {
    // // Create a single timeout that applies to the entire request
    // let timeoutId;
    // let isTimedOut = false;

    // const timeoutPromise = new Promise((resolve, reject) => {
    //   timeoutId = setTimeout(() => {
    //     isTimedOut = true;
    //     reject(
    //       new Error(
    //         `Request timed out after ${validatedTimeout / 1000} seconds`
    //       )
    //     );
    //   }, validatedTimeout);
    // });

    params = {
      model: model,
      messages: messages,
      temperature: temperature,
      top_p: top_p,
      stream: stream,
      stream_options: stream ? {include_usage: true } : null,
      timeout: timeout,
      chat_template_kwargs: chat_template_kwargs,
      reasoning_effort: reasoning_effort,
    }

    const isExternalModel = (model.startsWith("openai-") && !model.startsWith("openai-gpt-oss")) || model.startsWith("claude");
    inference_service = model;

    if (arcana && arcana.id !== "") {
      params.arcana = arcana;
    }

    if (feedback){
      params.feedback = feedback;
    }

    // Handle tools and arcana
    if (enable_tools && !isExternalModel) {
      inference_service = "saia-openai-gateway";
      params["runToolsOnServer"] = true;
      if (mcp_servers && mcp_servers.length > 0) {
        params["mcp-servers"] = mcp_servers;
      }
      if (tools && tools.length > 0) {
        params.tools = [];
        for (const tool of tools) {
          if (tool.type === "web_search_preview" || tool.type === "web_search") {
            params.tools.push({type: "web_search_preview"});
          }
          if (tool.type === "fetch_url") {
            params.tools.push({type: "fetch_url"});
          }
          if (tool.type === "image_generation") {
            params.tools.push({type: "image_generation"});
          }
          if (tool.type === "video_generation") {
            params.tools.push({type: "video_create"});
          }
          if (tool.type === "image_modify" || tool.type === "image_modification") {
            params.tools.push({type: "image_modify"});
          }
          if (tool.type === "audio_generation") {
            params.tools.push({type: "audio_generation"});
          }
          if (tool.type === "arcana" && (!params.arcana || !params.arcana.id)) {
            params.tools.push({type: "arcana_list_files"});
            params.tools.push({type: "arcana_get_file_content"});
            params.tools.push({type: "arcana_retrieve_knowledge"});
          }
          if (tool.type === "audio_transcription") {
            params.tools.push({type: "audio_transcription"});
          }
          if (tool.type === "runRscript") {
            params.tools.push({type: "runRscript"});
          }
        }
      }
    }
    
    const openai = new OpenAI({baseURL : apiEndpoint, apiKey: apiKey ? apiKey : inference_id});

    // Temporary workaround as middleware doesn't support timeout yet
    if (params.arcana || params.model.includes("rag") || params.model.includes("sauerkraut")) delete params.timeout;
    
    // Build headers object
    const headers = {
      "inference-service": inference_service,
      "inference-portal": serviceName,
      "user": uid
    };

    // Add inference-id only if it's not null/undefined
    if (inference_id) {
      headers["inference-id"] = inference_id;
    }

    // Get chat completion response
    const response = await openai.chat.completions.create(params, {
        headers
    }).asResponse();

    // Pass through headers (optional but recommended)
    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    // Stream with error handling
    const nodeStream = Readable.fromWeb(response.body);

    nodeStream.on('error', (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).end("Upstream error");
      } else {
        res.end(); // gracefully end if already streaming
      }
    });
    nodeStream.on('end', () => {
      // Ensure the connection is closed properly
      if (!res.writableEnded) {
        res.end();
      }
    });

    nodeStream.pipe(res);
  } catch (err) {
    try {
      // Well-formed error, return
      if (err?.status && err?.error) {
        return res
        .status(err?.status || 500)
        .json({
          error: err?.error || "An internal server error occurred",
         });
      }
      // Couldn't extract error message, so try without openai library
      const response = await fetch(apiEndpoint + "/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ apiKey ? apiKey : inference_id }`,
          "Content-Type": "application/json",
          "inference-service": inference_service,
          "inference-portal": serviceName,
          "inference-id": inference_id
        },
        body: JSON.stringify(params)
      });
      // Extract message and status from HTTP response
      let msg, status;
      try {
        status = response.status;
        msg = await response.text();
        msg = JSON.parse(msg);
        msg = msg?.message || msg;
        const match = msg.match(/'msg':\s*'([^']*)'/);
        if (match) {
          msg = match[1];
          console.log("Extracted message:", msg);
        }
      } catch {}
      // Return message as best as possible
      return res
        .status(status || err?.status || 500)
        .json({
          error: msg || "An unknown error occurred",
        });
    } catch (err) {
      console.error(err);
      return;
    }
  }
});

// Start Chat AI Backend App
app.listen(port, () => {
  console.log(`Chat AI backend listening on port ${port}`);
});
