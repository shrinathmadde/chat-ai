import { useEffect, useMemo, useRef } from "react";

// Which text box the mic under the prompt types into: the one the cursor was
// in last (the prompt box or a report), else the prompt box. Module state, as
// there is one mic on the page.
let last = null;
let fallback = null;

export function getDictationTarget() {
  return last?.element()?.isConnected ? last : fallback;
}

// Makes the text box in `ref` a target for the mic and returns the handler for
// its onFocus. insert(transcript) puts dictated text into it. The default
// target (the prompt box) gets the text while no other box has the cursor.
export function useDictationTarget(ref, insert, { isDefault = false } = {}) {
  const insertRef = useRef(insert);
  useEffect(() => {
    insertRef.current = insert;
  });
  const target = useMemo(
    () => ({ element: () => ref.current, insert: (text) => insertRef.current(text) }),
    []
  );
  useEffect(() => {
    if (isDefault) fallback = target;
    return () => {
      if (last === target) last = null;
      if (fallback === target) fallback = null;
    };
  }, []);
  return () => {
    last = target;
  };
}
