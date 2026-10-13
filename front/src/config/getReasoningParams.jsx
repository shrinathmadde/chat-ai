import getModelDefaults from "./getModelDefaults";

// Reasoning ("thinking") request parameters for a model, from its capability
// file and the conversation's reasoning setting. Returns the fields to add to
// the request: reasoning_effort and/or chat_template_kwargs, or none. Shared by
// chat completions and the radiology report pipeline, so the thinking toggle
// means the same in both.
export default function getReasoningParams(model, settings) {
  const params = {};
  const modelDefaults = getModelDefaults(model);
  try {
    if (modelDefaults?.reasoning_effort !== undefined && modelDefaults?.reasoning_effort !== null) {
      let reasoning_effort = modelDefaults.reasoning_effort;
      if (settings?.reasoning_effort !== undefined && settings?.reasoning_effort !== null) {
        reasoning_effort = Math.min(settings.reasoning_effort, modelDefaults.reasoning_options.length - 1)
      }
      if (model?.toLowerCase().startsWith("claude")) {
        // External Claude models
        params.reasoning_effort = modelDefaults.reasoning_options[reasoning_effort];
      }
      else if (model?.toLowerCase().startsWith("openai") && !(model?.toLowerCase().startsWith("openai-gpt-oss"))) {
        // External OpenAI models
        params.reasoning_effort = modelDefaults.reasoning_options[reasoning_effort];
      }
      if (model?.toLowerCase().includes("mistral")) {
        // Internal models that don't use enable_thinking separately
        params.reasoning_effort = modelDefaults.reasoning_options[reasoning_effort];
      }
      else {
        if (reasoning_effort == 0) {
          params.chat_template_kwargs = modelDefaults.reasoning_options[0] == "none" ?
            {enable_thinking: false} : {reasoning_effort: modelDefaults.reasoning_options[0]};
        } else if (modelDefaults.reasoning_options[reasoning_effort] == "on") {
          params.chat_template_kwargs = {enable_thinking: true};
        } else {
          params.chat_template_kwargs = {enable_thinking: true, reasoning_effort: modelDefaults.reasoning_options[reasoning_effort]};
        }
      }
    }
  }  catch {
    console.warn("Could not find reasoning setting")
  }
  return params;
}
