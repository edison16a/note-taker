"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "rt_transcriber_v1";

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function isoDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function prettyDayLabel(iso) {
  // iso: YYYY-MM-DD
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function docTextFromDay(day) {
  if (!day) return "";
  if (typeof day.docText === "string") return day.docText;
  return (day.entries || []).map((e) => e.text).filter(Boolean).join("\n\n");
}

const DEFAULT_STATE = {
  classes: [
    {
      id: uid(),
      name: "Gov",
      days: {}, // { "YYYY-MM-DD": { id, label, entries: [{id, ts, text}] } }
    },
  ],
  selectedClassId: null,
  selectedDayId: null,
};

export default function Page() {
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState(DEFAULT_STATE);

  // UI state
  const [interim, setInterim] = useState("");
  const [status, setStatus] = useState("Idle");

  const [error, setError] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [editingClassId, setEditingClassId] = useState(null);
  const [editingClassValue, setEditingClassValue] = useState("");
  const [editingDayId, setEditingDayId] = useState(null);
  const [editingDayValue, setEditingDayValue] = useState("");

  // Speech recognition refs
  const recognitionRef = useRef(null);
  const keepListeningRef = useRef(false);

  // Debounced save
  const saveTimerRef = useRef(null);

  const selectedClass = useMemo(() => {
    return state.classes.find((c) => c.id === state.selectedClassId) || null;
  }, [state]);

  const selectedDay = useMemo(() => {
    if (!selectedClass) return null;
    const dayId = state.selectedDayId;
    if (!dayId) return null;
    return selectedClass.days?.[dayId] || null;
  }, [selectedClass, state.selectedDayId]);

  function scheduleSave(nextState) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      } catch (e) {
        // If storage is full or blocked, surface a message.
        console.error(e);
      }
    }, 150);
  }

  function commit(next) {
    setState((prev) => {
      const nextState = typeof next === "function" ? next(prev) : next;
      if (typeof window !== "undefined") scheduleSave(nextState);
      return nextState;
    });
  }

  // Load initial state
  useEffect(() => {
    const loaded = safeParse(
      typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : "",
      null
    );

    let next = loaded && loaded.classes ? loaded : DEFAULT_STATE;

    // Ensure selected class/day are valid
    if (!next.selectedClassId || !next.classes.some((c) => c.id === next.selectedClassId)) {
      next.selectedClassId = next.classes[0]?.id || null;
    }

    // Ensure "today" day exists for selected class and is selected
    const today = isoDay(new Date());
    const cIdx = next.classes.findIndex((c) => c.id === next.selectedClassId);
    if (cIdx >= 0) {
      next = ensureDay(next, next.selectedClassId, today);
      if (!next.selectedDayId || !next.classes[cIdx].days?.[next.selectedDayId]) {
        next.selectedDayId = today;
      }
    }

    setState(next);
    setHydrated(true);

    // Save back normalized state (in case we fixed selection)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop listening when switching class/day (prevents audio running “in background” on wrong tab)
  useEffect(() => {
    if (isListening) stopListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedClassId, state.selectedDayId]);

  // Clear inline editors when switching context
  useEffect(() => {
    setEditingDayId(null);
    setEditingDayValue("");
  }, [state.selectedClassId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try {
        keepListeningRef.current = false;
        recognitionRef.current?.stop?.();
      } catch {}
    };
  }, []);

  function ensureDay(s, classId, dayId) {
    const next = structuredClone(s);
    const c = next.classes.find((x) => x.id === classId);
    if (!c) return next;

    if (!c.days) c.days = {};
    if (!c.days[dayId]) {
      const count = Object.keys(c.days).length + 1;
      c.days[dayId] = {
        id: dayId,
        label: `Class ${count}`,
        entries: [],
        docText: "",
      };
    } else if (typeof c.days[dayId].docText !== "string") {
      c.days[dayId].docText = docTextFromDay(c.days[dayId]);
    }
    return next;
  }

  function selectClass(classId) {
    const today = isoDay(new Date());
    let next = ensureDay(state, classId, today);
    next.selectedClassId = classId;

    // If previous selected day doesn't exist for this class, default to today
    const c = next.classes.find((x) => x.id === classId);
    const dayId = next.selectedDayId;
    if (!c?.days?.[dayId]) next.selectedDayId = today;

    commit(next);
    setEditingDayId(null);
  }

  function selectDay(dayId) {
    let next = ensureDay(state, state.selectedClassId, dayId);
    next.selectedDayId = dayId;
    commit(next);
    setEditingDayId(null);
    setEditingDayValue("");
  }

  function addClass() {
    const newId = uid();
    const name = "New class";
    const newClass = { id: newId, name, days: {} };

    let next = structuredClone(state);
    next.classes.push(newClass);
    next.selectedClassId = newId;

    const today = isoDay(new Date());
    next = ensureDay(next, newId, today);
    next.selectedDayId = today;

    commit(next);
    setEditingClassId(newId);
    setEditingClassValue(name);
  }

  function renameClass(classId) {
    const c = state.classes.find((x) => x.id === classId);
    if (!c) return;
    setEditingClassId(classId);
    setEditingClassValue(c.name || "");
  }

  function deleteClass(classId) {
    const c = state.classes.find((x) => x.id === classId);
    if (!c) return;
    const ok = confirm(`Delete "${c.name}" and all its transcripts?`);
    if (!ok) return;

    let next = structuredClone(state);
    next.classes = next.classes.filter((x) => x.id !== classId);

    if (next.classes.length === 0) {
      next = structuredClone(DEFAULT_STATE);
      next.selectedClassId = next.classes[0].id;
      const today = isoDay(new Date());
      next = ensureDay(next, next.selectedClassId, today);
      next.selectedDayId = today;
      commit(next);
      return;
    }

    if (next.selectedClassId === classId) {
      next.selectedClassId = next.classes[0].id;
      const today = isoDay(new Date());
      next = ensureDay(next, next.selectedClassId, today);
      next.selectedDayId = today;
    }

    commit(next);
  }

  function saveClassName(classId, name) {
    const trimmed = (name || "").trim() || "Untitled class";
    commit((prev) => {
      const next = structuredClone(prev);
      const target = next.classes.find((x) => x.id === classId);
      if (target) target.name = trimmed;
      return next;
    });
    setEditingClassId(null);
    setEditingClassValue("");
  }

  function addDate() {
    const base = isoDay(new Date());
    const c = state.classes.find((x) => x.id === state.selectedClassId);
    const existingCount = Object.keys(c?.days || {}).length;
    const label = `Class ${existingCount + 1}`;

    let newId = base;
    let counter = 1;
    while (c?.days?.[newId]) {
      counter += 1;
      newId = `${base}-${counter}`;
    }

    commit((prev) => {
      const next = structuredClone(prev);
      const cls = next.classes.find((x) => x.id === next.selectedClassId);
      if (!cls) return prev;
      if (!cls.days) cls.days = {};
      cls.days[newId] = { id: newId, label, entries: [], docText: "" };
      next.selectedDayId = newId;
      return next;
    });
    setEditingDayId(newId);
    setEditingDayValue(label);
  }

  function renameDay(dayId) {
    if (!selectedClass) return;
    const d = selectedClass.days?.[dayId];
    if (!d) return;
    setEditingDayId(dayId);
    setEditingDayValue(d.label || "");
  }

  function clearDay() {
    if (!selectedClass || !state.selectedDayId) return;
    const ok = confirm("Clear all transcript entries for this SubTab?");
    if (!ok) return;

    const next = structuredClone(state);
    const c = next.classes.find((x) => x.id === next.selectedClassId);
    if (c?.days?.[next.selectedDayId]) {
      c.days[next.selectedDayId].entries = [];
      c.days[next.selectedDayId].docText = "";
    }
    commit(next);
  }

  function saveDayLabel(dayId, label) {
    const trimmed = (label || "").trim() || "Untitled note";
    commit((prev) => {
      const next = structuredClone(prev);
      const c = next.classes.find((x) => x.id === next.selectedClassId);
      if (c?.days?.[dayId]) c.days[dayId].label = trimmed;
      return next;
    });
    setEditingDayId(null);
    setEditingDayValue("");
  }

  function exportDay() {
    if (!selectedClass || !selectedDay) return;
    const docText = docTextFromDay(selectedDay);
    const lines = [];
    lines.push(`Class: ${selectedClass.name}`);
    lines.push(`SubTab: ${selectedDay.label} (${selectedDay.id})`);
    lines.push("");
    lines.push(docText || "[No notes yet]");
    const filename = `${selectedClass.name.replaceAll(" ", "_")}_${selectedDay.id}.txt`;
    downloadText(filename, lines.join("\n"));
  }

  function updateDocText(nextText) {
    commit((prev) => {
      const next = ensureDay(
        prev,
        prev.selectedClassId,
        prev.selectedDayId || isoDay(new Date())
      );
      const c = next.classes.find((x) => x.id === next.selectedClassId);
      const day = c?.days?.[next.selectedDayId];
      if (day) day.docText = nextText;
      return next;
    });
  }

  function appendFinalText(text) {
    if (!text || !text.trim()) return;
    commit((prev) => {
      const next = ensureDay(
        prev,
        prev.selectedClassId,
        prev.selectedDayId || isoDay(new Date())
      );
      const c = next.classes.find((x) => x.id === next.selectedClassId);
      if (!c) return prev;

      const dayId = next.selectedDayId || isoDay(new Date());
      if (!c.days) c.days = {};
      if (!c.days[dayId]) {
        const count = Object.keys(c.days).length + 1;
        c.days[dayId] = { id: dayId, label: `Class ${count}`, entries: [], docText: "" };
      }
      const clean = text.trim();
      c.days[dayId].entries.push({ id: uid(), ts: Date.now(), text: clean });
      const existing = typeof c.days[dayId].docText === "string" ? c.days[dayId].docText : "";
      c.days[dayId].docText = existing ? `${existing.trimEnd()}\n\n${clean}` : clean;
      return next;
    });
  }

  function isSpeechSupported() {
    if (typeof window === "undefined") return false;
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function startListening() {
    setError("");
    setInterim("");

    if (!isSpeechSupported()) {
      setError("Speech recognition not supported. Use Chrome on desktop.");
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();

    rec.continuous = true; // Chrome may still stop; we auto-restart onend
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setStatus("Listening…");
      setIsListening(true);
    };

    rec.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0]?.transcript || "";
        if (res.isFinal) {
          appendFinalText(transcript);
        } else {
          interimText += transcript;
        }
      }
      setInterim(interimText.trim());
    };

    rec.onerror = (e) => {
      const msg =
        e?.error === "not-allowed"
          ? "Microphone permission denied. Allow mic access and retry."
          : `Speech error: ${e?.error || "unknown"}`;
      setError(msg);
      keepListeningRef.current = false;
      setStatus("Idle");
      setIsListening(false);
      try {
        rec.stop();
      } catch {}
    };

    rec.onend = () => {
      // Chrome sometimes ends after pauses; restart if user still wants listening
      if (keepListeningRef.current) {
        try {
          rec.start();
        } catch {
          // If restart fails, stop cleanly
          keepListeningRef.current = false;
          setStatus("Idle");
          setIsListening(false);
        }
      } else {
        setStatus("Idle");
        setIsListening(false);
      }
    };

    recognitionRef.current = rec;
    keepListeningRef.current = true;

    try {
      rec.start();
    } catch (e) {
      setError("Could not start speech recognition. Try refreshing and allowing mic access.");
      keepListeningRef.current = false;
      setStatus("Idle");
      setIsListening(false);
    }
  }

  function stopListening() {
    keepListeningRef.current = false;
    setInterim("");
    setStatus("Idle");
    setIsListening(false);
    try {
      recognitionRef.current?.stop?.();
    } catch {}
  }

  function toggleListening() {
    if (isListening) stopListening();
    else startListening();
  }

  const daysSorted = useMemo(() => {
    if (!selectedClass?.days) return [];
    return Object.values(selectedClass.days).sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first
  }, [selectedClass]);

  const docText = useMemo(() => docTextFromDay(selectedDay), [selectedDay]);
  const wordCount = useMemo(() => {
    if (!docText.trim()) return 0;
    return docText.trim().split(/\s+/).filter(Boolean).length;
  }, [docText]);

  // Hydration guard so we don’t flash default state before loading localStorage
  if (!hydrated) {
    return (
      <div className="shell">
        <div className="loadingCard">
          <div className="spinner" />
          <div>
            <div className="loadingTitle">Loading your transcripts…</div>
            <div className="loadingSub">Reading local storage</div>
          </div>
        </div>
      </div>
    );
  }

  const headerTitle = selectedClass ? selectedClass.name : "No Class Selected";
  const dayTitle = selectedDay ? selectedDay.label : "No Date Selected";

  return (
    <div className="shell">
      <div className="appCard">
        <aside className="sidebar">
          <div className="brand">
            <div className="logo">CT</div>
            <div className="brandText">
              <div className="brandTitle">Class Note Taker</div>
              <div className="brandSub">Classes • Dates • Local Save</div>
            </div>
          </div>

          <div className="sidebarSection">
            <div className="sectionHeader">
              <div className="sectionTitle">Classes</div>
              <button className="btn btnPrimary btnSmall" onClick={addClass} title="Add class">
                New Class
              </button>
            </div>

            <div className="classList">
              {state.classes.map((c) => {
                const active = c.id === state.selectedClassId;
                return (
                  <div
                    key={c.id}
                    className={`classItem ${active ? "active" : ""}`}
                    onClick={() => selectClass(c.id)}
                    onDoubleClick={() => renameClass(c.id)}
                    role="button"
                    tabIndex={0}
                  >
                    {editingClassId === c.id ? (
                      <input
                        className="inlineInput"
                        value={editingClassValue}
                        onChange={(e) => setEditingClassValue(e.target.value)}
                        onBlur={() => saveClassName(c.id, editingClassValue)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveClassName(c.id, editingClassValue);
                          if (e.key === "Escape") {
                            setEditingClassId(null);
                            setEditingClassValue("");
                          }
                        }}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div className="className">{c.name}</div>
                    )}
                    <div className="classActions" onClick={(e) => e.stopPropagation()}>
                      <button className="iconBtn" onClick={() => renameClass(c.id)} title="Rename">
                        ✎
                      </button>
                      <button className="iconBtn danger" onClick={() => deleteClass(c.id)} title="Delete">
                        🗑
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {selectedClass ? (
              <div className="sidebarSection">
                <div className="sectionHeader">
                  <div className="sectionTitle">{selectedClass.name} SubTabs</div>
                  <button className="btn btnSmall btnGhost" onClick={addDate} title="Add subtab">
                    New SubTab
                  </button>
                </div>
                <div className="dateList">
                  {daysSorted.length === 0 ? (
                    <div className="muted">No SubTabs yet.</div>
                  ) : (
                    daysSorted.map((d) => {
                      const active = d.id === state.selectedDayId;
                      const meta = /^\d{4}-\d{2}-\d{2}/.test(d.id)
                        ? prettyDayLabel(d.id.slice(0, 10))
                        : d.id;
                      return (
                        <div
                          key={d.id}
                          className={`dateItem ${active ? "active" : ""}`}
                          onClick={() => selectDay(d.id)}
                          onDoubleClick={() => renameDay(d.id)}
                          role="button"
                          tabIndex={0}
                        >
                          {editingDayId === d.id ? (
                            <input
                              className="inlineInput"
                              value={editingDayValue}
                              onChange={(e) => setEditingDayValue(e.target.value)}
                              onBlur={() => saveDayLabel(d.id, editingDayValue)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveDayLabel(d.id, editingDayValue);
                                if (e.key === "Escape") {
                                  setEditingDayId(null);
                                  setEditingDayValue("");
                                }
                              }}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <div className="dateItemText">
                              <div className="dateItemLabel">{d.label}</div>
                              <div className="dateItemMeta">{meta}</div>
                            </div>
                          )}
                          <div className="classActions" onClick={(e) => e.stopPropagation()}>
                            <button className="iconBtn" onClick={() => renameDay(d.id)} title="Rename subtab">
                              ✎
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <div>
              <div className="titleRow">
                <h1 className="title">{headerTitle}</h1>
                <div className="statusDotWrap" title={isListening ? "Listening" : "Idle"}>
                  <span className={`statusDot ${isListening ? "on" : "off"}`} />
                  <span className={`statusDotPing ${isListening ? "on" : "off"}`} />
                </div>
                <span className={`pill ${isListening ? "pillLive" : "pillIdle"}`}>
                  {isListening ? "LIVE" : "IDLE"}
                </span>
              </div>
              <div className="subtitle">{dayTitle}</div>
            </div>

            <div className="topbarActions">
              <button className={`btn ${isListening ? "btnDanger" : "btnPrimary"}`} onClick={toggleListening}>
                {isListening ? "Stop" : "Listen"}
              </button>
              <button className="btn btnGhost" onClick={exportDay} disabled={!selectedDay}>
                Export txt file
              </button>
              <button className="btn btnGhost" onClick={clearDay} disabled={!selectedDay}>
                Clear Notes
              </button>
            </div>
          </header>

          <section className="contentGrid">
            <div className="panel panelWide">
              <div className="panelHeader">
                <div className="panelTitle">Live Notes</div>
               
              </div>
              <div className="panelBody">
                <div className={`liveBox ${isListening ? "liveOn" : ""}`}>
                  <div className="liveLabel">Transcribing</div>
                  <div className="liveText">{interim || "…"}</div>
                </div>

                <div className="docHeader">
                  <div>
                    <div className="entriesTitle">Notebook</div>
                  
                  </div>
                  <div className="docMeta">
                    {wordCount} word{wordCount === 1 ? "" : "s"}
                  </div>
                </div>

                <div className="docShell">
                  <textarea
                    className="docEditor"
                    value={selectedDay ? docText : ""}
                    onChange={(e) => updateDocText(e.target.value)}
                    placeholder="Start typing or press Listen to dictate. Each new thought will drop in as its own paragraph."
                    disabled={!selectedDay}
                  />
                </div>

                <div className="docFooter">
                  <span>
                    {error
                      ? error
                      : isSpeechSupported()
                      ? `Status: ${status}`
                      : "Speech recognition not supported"}
                  </span>
                  <span className="docSaveHint">Autosaves locally.</span>
                </div>
              </div>
            </div>
          </section>

          <footer className="footer">
            <div>
              Double-click a Tab to rename it.
            </div>
            <div className="footerRight">
              Stored locally in your browser.
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
