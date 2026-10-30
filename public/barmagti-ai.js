/*
 * برمجتي AI — ودجت جاهز يتحط في المنصة
 * الاستخدام:
 *   BarmagtiAI.mount(document.getElementById("ai-box"), {
 *     apiUrl: "https://barmagti-ai.<your-subdomain>.workers.dev",
 *     getToken: () => firebase.auth().currentUser.getIdToken(),   // أو auth.currentUser.getIdToken() في الـ modular
 *     onGraded: (result) => {}  // اختياري: تحفظ النتيجة في Firestore لو عايز
 *   });
 * مفيش أي مفتاح API هنا — كل حاجة سرية على السيرفر.
 */
(function () {
  const CSS = `
  .bai{direction:rtl;font-family:"Cairo","Tajawal",system-ui,sans-serif;color:#1f2937;background:#fff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;max-width:820px}
  .bai *{box-sizing:border-box}
  .bai-tabs{display:flex;background:#f3f4f6;border-bottom:1px solid #e5e7eb}
  .bai-tab{flex:1;padding:12px;border:0;background:none;font:inherit;font-weight:700;cursor:pointer;color:#6b7280}
  .bai-tab[aria-selected=true]{color:#4f46e5;background:#fff;box-shadow:inset 0 -3px 0 #4f46e5}
  .bai-pane{padding:16px;display:none}.bai-pane.on{display:block}
  .bai-log{height:340px;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:4px}
  .bai-msg{padding:10px 14px;border-radius:14px;max-width:88%;line-height:1.7;white-space:pre-wrap;word-wrap:break-word}
  .bai-me{align-self:flex-start;background:#4f46e5;color:#fff}
  .bai-bot{align-self:flex-end;background:#f3f4f6}
  .bai pre{direction:ltr;text-align:left;background:#111827;color:#e5e7eb;padding:10px;border-radius:10px;overflow:auto;white-space:pre;font-family:Consolas,monospace;font-size:13px;margin:6px 0}
  .bai-src{font-size:12px;color:#6b7280;margin-top:6px}
  .bai-row{display:flex;gap:8px;margin-top:10px}
  .bai input,.bai textarea,.bai select{font:inherit;border:1px solid #d1d5db;border-radius:10px;padding:10px;width:100%}
  .bai textarea.code{direction:ltr;text-align:left;font-family:Consolas,monospace;min-height:160px}
  .bai button.go{background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:10px 18px;font:inherit;font-weight:700;cursor:pointer;white-space:nowrap}
  .bai button.go:disabled{opacity:.5;cursor:wait}
  .bai label{display:block;font-weight:700;margin:10px 0 4px}
  .bai-q{background:#eef2ff;border-radius:12px;padding:12px;margin:10px 0;white-space:pre-wrap}
  .bai-res{margin-top:14px;border-radius:12px;padding:14px;border:1px solid #e5e7eb}
  .bai-score{font-size:28px;font-weight:800}
  .bai-correct{border-color:#10b981;background:#ecfdf5}.bai-partial{border-color:#f59e0b;background:#fffbeb}.bai-wrong{border-color:#ef4444;background:#fef2f2}
  .bai-res ul{margin:6px 0;padding-right:20px}
  .bai-err{color:#b91c1c;margin-top:8px}
  .bai-small{font-size:13px;color:#6b7280}
  `;

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }

  // عرض آمن لرد الـ AI: نص عادي + بلوكات كود (مفيش innerHTML)
  function richText(text) {
    const box = el("div");
    String(text).split(/```(?:\w+)?\n?/).forEach((part, i) => {
      if (i % 2) box.append(el("pre", {}, part.replace(/\n$/, "")));
      else if (part) box.append(document.createTextNode(part));
    });
    return box;
  }

  function mount(root, opts) {
    if (!document.getElementById("bai-css")) document.head.append(el("style", { id: "bai-css" }, CSS));
    const api = async (method, path, body) => {
      const token = await opts.getToken();
      const r = await fetch(opts.apiUrl.replace(/\/$/, "") + path, {
        method,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "حصلت مشكلة");
      return j;
    };

    const wrap = el("div", { class: "bai" });
    const tabs = el("div", { class: "bai-tabs", role: "tablist" });
    const panes = {};
    const show = (id) => {
      for (const b of tabs.children) b.setAttribute("aria-selected", b.dataset.id === id);
      for (const [k, p] of Object.entries(panes)) p.classList.toggle("on", k === id);
    };
    const addTab = (id, label) => {
      const b = el("button", { class: "bai-tab", role: "tab", onclick: () => show(id) }, label);
      b.dataset.id = id;
      tabs.append(b);
      panes[id] = el("div", { class: "bai-pane" });
      return panes[id];
    };

    // ---------- مساعد المذاكرة ----------
    const chat = addTab("chat", "🤖 مساعد المذاكرة");
    const log = el("div", { class: "bai-log" });
    const qIn = el("input", { placeholder: "اسأل في أي حاجة في المنهج… مثلاً: يعني إيه range؟" });
    const qBtn = el("button", { class: "go" }, "اسأل");
    const history = [];
    log.append(el("div", { class: "bai-msg bai-bot" }, "أهلاً 👋 أنا مساعد برمجتي. بجاوبك من المنهج بتاعك بس."));
    async function ask() {
      const q = qIn.value.trim();
      if (!q) return;
      qIn.value = "";
      log.append(el("div", { class: "bai-msg bai-me" }, q));
      const wait = el("div", { class: "bai-msg bai-bot" }, "بدوّر في المنهج…");
      log.append(wait);
      log.scrollTop = log.scrollHeight;
      qBtn.disabled = true;
      try {
        const res = await api("POST", "/api/ask", { question: q, history });
        wait.textContent = "";
        wait.append(richText(res.answer));
        if (res.sources?.length)
          wait.append(el("div", { class: "bai-src" }, "📖 المصادر: " + res.sources.map((s) => `[${s.ref}] ${s.lesson}`).join(" • ")));
        history.push({ role: "user", content: q }, { role: "assistant", content: res.answer });
      } catch (e) {
        wait.textContent = "⚠️ " + e.message;
      } finally {
        qBtn.disabled = false;
        log.scrollTop = log.scrollHeight;
      }
    }
    qBtn.onclick = ask;
    qIn.onkeydown = (e) => e.key === "Enter" && ask();
    chat.append(log, el("div", { class: "bai-row" }, qIn, qBtn));

    // ---------- مصحّح الواجبات ----------
    const hw = addTab("hw", "📝 صحّحلي الواجب");
    const sel = el("select");
    const qBox = el("div", { class: "bai-q" }, "اختار الواجب…");
    const ans = el("textarea", { class: "code", placeholder: "اكتب إجابتك أو الكود هنا…" });
    const gBtn = el("button", { class: "go" }, "صحّح");
    const out = el("div");
    let assignments = [];
    sel.onchange = () => {
      const a = assignments.find((x) => x.id === sel.value);
      qBox.textContent = a ? `${a.question}\n\nالدرجة من ${a.maxScore}` : "";
    };
    gBtn.onclick = async () => {
      out.textContent = "";
      if (!sel.value || !ans.value.trim()) return out.append(el("div", { class: "bai-err" }, "اختار الواجب واكتب إجابتك"));
      gBtn.disabled = true;
      gBtn.textContent = "بيصحّح…";
      try {
        const r = await api("POST", "/api/grade", { assignmentId: sel.value, answer: ans.value });
        const card = el("div", { class: "bai-res bai-" + r.verdict },
          el("div", { class: "bai-score" }, `${r.score} من ${r.maxScore}`),
          el("p", {}, r.summary));
        if (r.strengths?.length) card.append(el("b", {}, "✅ عملت صح:"), el("ul", {}, ...r.strengths.map((s) => el("li", {}, s))));
        if (r.mistakes?.length)
          card.append(el("b", {}, "🔧 محتاج تصلّح:"), el("ul", {}, ...r.mistakes.map((m) => el("li", {}, m.issue, el("div", { class: "bai-small" }, "💡 " + m.hint)))));
        card.append(el("p", {}, el("b", {}, "👣 الخطوة الجاية: "), r.nextStep));
        if (r.sources?.length) card.append(el("div", { class: "bai-src" }, "📖 راجع: " + r.sources.map((s) => s.lesson).join(" • ")));
        out.append(card);
        opts.onGraded?.(r);
      } catch (e) {
        out.append(el("div", { class: "bai-err" }, "⚠️ " + e.message));
      } finally {
        gBtn.disabled = false;
        gBtn.textContent = "صحّح";
      }
    };
    hw.append(el("label", {}, "الواجب"), sel, qBox, el("label", {}, "إجابتك"), ans, el("div", { class: "bai-row" }, gBtn), out);

    async function loadAssignments() {
      try {
        assignments = await api("GET", "/api/assignments");
        sel.replaceChildren(el("option", { value: "" }, assignments.length ? "— اختار —" : "مفيش واجبات لسه"),
          ...assignments.map((a) => el("option", { value: a.id }, a.title)));
        sel.onchange();
      } catch (e) {
        qBox.textContent = "⚠️ " + e.message;
      }
    }

    // ---------- لوحة المعلم (بتظهر للمعلم بس) ----------
    function teacherPane() {
      const p = addTab("teacher", "👨‍🏫 واجبات (المعلم)");
      const f = {
        id: el("input", { placeholder: "مثال: unit12-hw1 (إنجليزي وأرقام)" }),
        title: el("input", { placeholder: "عنوان الواجب" }),
        lesson: el("input", { placeholder: "الدرس (اختياري)" }),
        question: el("textarea", { placeholder: "نص السؤال" }),
        modelAnswer: el("textarea", { class: "code", placeholder: "الإجابة النموذجية (مش هتظهر للطلاب)" }),
        rubric: el("textarea", { placeholder: "معايير التصحيح: مثلاً 4 درجات لاستخدام for صح، 3 للـ range، 3 للطباعة" }),
        maxScore: el("input", { type: "number", value: "10", min: "1", max: "100" }),
      };
      const msg = el("div", { class: "bai-small" });
      const save = el("button", { class: "go", onclick: async () => {
        msg.textContent = "بيحفظ…";
        try {
          const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]));
          await api("PUT", "/api/teacher/assignments/" + encodeURIComponent(body.id.trim()), body);
          msg.textContent = "✅ اتحفظ";
          loadAssignments();
        } catch (e) { msg.textContent = "⚠️ " + e.message; }
      } }, "حفظ الواجب");
      const labels = { id: "كود الواجب", title: "العنوان", lesson: "الدرس", question: "السؤال", modelAnswer: "الإجابة النموذجية", rubric: "معايير التصحيح", maxScore: "الدرجة النهائية" };
      for (const k in f) p.append(el("label", {}, labels[k]), f[k]);
      p.append(el("div", { class: "bai-row" }, save), msg);
    }

    wrap.append(tabs, ...Object.values(panes));
    root.replaceChildren(wrap);
    show("chat");
    loadAssignments();
    api("GET", "/api/me").then((me) => {
      if (me.teacher) {
        teacherPane();
        wrap.append(panes.teacher);
      }
    }).catch(() => {});
  }

  window.BarmagtiAI = { mount };
})();
