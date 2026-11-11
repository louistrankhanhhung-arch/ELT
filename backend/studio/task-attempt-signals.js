(() => {
  const trackers = new Set();
  let current = null;
  let currentQuestion = -1;
  let segmentStarted = performance.now();
  let hiddenSince = null;
  let frame = 0;

  const limit = value => Math.min(86_400_000, Math.max(0, Math.round(value)));
  function finishSegment(now) {
    if (current && hiddenSince === null) {
      const elapsed = now - segmentStarted;
      current.visible += elapsed;
      if (currentQuestion >= 0) current.questions[currentQuestion] += elapsed;
    }
    segmentStarted = now;
  }

  function select(tracker, question = -1) {
    if (tracker === current && question === currentQuestion) return;
    const now = performance.now();
    finishSegment(now);
    current = tracker;
    currentQuestion = question;
  }

  function visibleDistance(element) {
    if (!element?.isConnected || element.closest("[hidden]")) return Infinity;
    const rect = element.getBoundingClientRect();
    if (!rect.width || rect.bottom <= 0 || rect.top >= innerHeight) return Infinity;
    const top = Math.max(0, rect.top);
    const bottom = Math.min(innerHeight, rect.bottom);
    return Math.abs((top + bottom) / 2 - innerHeight / 2);
  }

  function selectVisible() {
    frame = 0;
    if (document.hidden || hiddenSince !== null) return;
    let best = null;
    let distance = Infinity;
    for (const tracker of trackers) {
      const next = visibleDistance(tracker.element);
      if (next >= distance) continue;
      best = tracker;
      distance = next;
    }
    let question = -1;
    if (best) {
      distance = Infinity;
      best.fields.forEach((field, index) => {
        const next = visibleDistance(field);
        if (next >= distance) return;
        question = index;
        distance = next;
      });
    }
    select(best, question);
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(selectVisible);
  }

  function leave() {
    if (hiddenSince !== null) return;
    const now = performance.now();
    finishSegment(now);
    hiddenSince = now;
    if (current) current.hiddenCount++;
  }

  function returnToPage() {
    if (hiddenSince === null) return;
    const now = performance.now();
    if (current) current.hidden += now - hiddenSince;
    hiddenSince = null;
    segmentStarted = now;
    schedule();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) leave();
    else returnToPage();
  });
  window.addEventListener("pagehide", () => {
    leave();
    for (const tracker of trackers) {
      tracker.persist(current === tracker ? Date.now() : null);
    }
  });
  window.addEventListener("pageshow", () => { if (!document.hidden) returnToPage(); });
  window.addEventListener("scroll", schedule, {capture: true, passive: true});
  window.addEventListener("resize", schedule);
  for (const event of ["pointerdown", "focusin"]) {
    document.addEventListener(event, ({target}) => {
      if (document.hidden || hiddenSince !== null) return;
      for (const tracker of trackers) {
        if (!tracker.element.contains(target)) continue;
        select(tracker, tracker.fields.findIndex(field => field.contains(target)));
        break;
      }
    });
  }

  window.createTaskAttemptTracker = (count, attemptKey) => {
    const storageKey = "reh-attempt:" + attemptKey;
    const tracker = {element: null, fields: [], visible: 0, hidden: 0, hiddenCount: 0,
      questions: Array(count).fill(0)};
    function snapshot() {
      const now = performance.now();
      finishSegment(now);
      return {
        visible_ms: limit(tracker.visible),
        hidden_ms: limit(tracker.hidden + (current === tracker && hiddenSince !== null ? now - hiddenSince : 0)),
        hidden_count: Math.min(10_000, tracker.hiddenCount),
        question_ms: tracker.questions.map(limit)
      };
    }
    try {
      const previous = JSON.parse(sessionStorage.getItem(storageKey));
      if (previous && previous.question_ms?.length === count) {
        tracker.visible = previous.visible_ms;
        tracker.hidden = previous.hidden_ms + (previous.left_at ? limit(Date.now() - previous.left_at) : 0);
        tracker.hiddenCount = previous.hidden_count;
        tracker.questions = previous.question_ms;
      }
      sessionStorage.removeItem(storageKey);
    } catch {}
    tracker.persist = left_at => {
      try { sessionStorage.setItem(storageKey, JSON.stringify({...snapshot(), left_at})); } catch {}
    };
    return {
      mount(element, fields = []) {
        tracker.element = element;
        tracker.fields = fields;
        trackers.add(tracker);
        schedule();
      },
      unmount() {
        trackers.delete(tracker);
        if (current === tracker) {
          if (hiddenSince !== null) tracker.hidden += performance.now() - hiddenSince;
          select(null);
        }
        tracker.element = null;
        tracker.fields = [];
        schedule();
      },
      complete() {
        this.unmount();
        try { sessionStorage.removeItem(storageKey); } catch {}
      },
      snapshot
    };
  };

  window.renderTaskAttemptSignals = (doc, signals) => {
    const details = doc.createElement("details");
    const add = (parent, tag, text) => {
      const element = doc.createElement(tag);
      element.textContent = text;
      parent.append(element);
      return element;
    };
    const seconds = ms => (ms / 1000).toFixed(1) + " s";
    add(details, "summary", "Attempt signals");
    if (!signals) {
      add(details, "p", "No signals were recorded for this submission.");
      return details;
    }
    const device = signals.device;
    add(details, "p", "Device: " + [device.type, device.os, device.browser].join(" · "));
    add(details, "p", "Page hidden: " + signals.hidden_count + " time(s) · " + seconds(signals.hidden_ms) +
      " hidden · " + seconds(signals.visible_ms) + " on task");
    if (signals.question_ms.length) {
      const list = add(details, "ul", "");
      signals.question_ms.forEach((ms, index) => {
        add(list, "li", "Question " + (index + 1) + ": " + seconds(ms));
      });
    }
    add(details, "small", "Approximate browser signals for review. Page switches and timing alone cannot establish misconduct.");
    return details;
  };
})();
