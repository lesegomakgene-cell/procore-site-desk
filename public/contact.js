"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const shownAt = Date.now();
  let agent = "us";
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

  function showError(msg) {
    const el = $("contactError");
    el.textContent = msg;
    el.hidden = !msg;
    if (msg) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function linkBtn(text, href, cls) {
    const a = document.createElement("a");
    a.className = "btn " + cls; a.textContent = text; a.href = href;
    if (!href.startsWith("mailto:")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    return a;
  }

  // public details: who you're writing to, topics, and quick contact links
  fetch("/api/public", { credentials: "same-origin" }).then((r) => r.json()).then((d) => {
    agent = d.agent && d.agent !== "the site agent" ? d.agent : "us";
    document.querySelectorAll(".agent-name").forEach((e) => (e.textContent = agent));

    const sel = $("c-topic");
    (d.contactTopics || ["Something else"]).forEach((t) => {
      const o = document.createElement("option"); o.value = t; o.textContent = t; sel.appendChild(o);
    });
    const wanted = new URLSearchParams(location.search).get("topic");
    if (wanted) { const m = [...sel.options].find((o) => o.value.toLowerCase().startsWith(wanted.toLowerCase())); if (m) sel.value = m.value; }

    if (d.agentWhatsappUrl) {
      $("quickWa").href = d.agentWhatsappUrl;
      $("quickWaText").textContent = d.agentWhatsapp;
      $("quickWa").hidden = false;
    }
    if (d.agentEmail) {
      $("quickMail").href = "mailto:" + d.agentEmail;
      $("quickMailText").textContent = d.agentEmail;
      $("quickMail").hidden = false;
    }
    $("quick").hidden = !(d.agentWhatsappUrl || d.agentEmail);
    $("quick").classList.toggle("single", !(d.agentWhatsappUrl && d.agentEmail));

    if (d.me) {
      $("backLink").href = "/"; $("backLink").textContent = "Back to Site Desk";
      document.querySelector(".brand").href = "/";
      if (!$("c-name").value) $("c-name").value = d.me.name || "";
      if (!$("c-email").value) $("c-email").value = d.me.email || "";
      if (!$("c-phone").value) $("c-phone").value = d.me.phone || "";
    }
  }).catch(() => {
    const sel = $("c-topic");
    const o = document.createElement("option"); o.value = "Something else"; o.textContent = "Something else"; sel.appendChild(o);
  });

  $("contactForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    const body = {
      name: $("c-name").value.trim(),
      email: $("c-email").value.trim(),
      phone: $("c-phone").value.trim(),
      topic: $("c-topic").value,
      message: $("c-message").value.trim(),
      website: $("c-website").value,
      elapsed: Date.now() - shownAt,
    };
    if (body.name.length < 2) return showError("Please enter your name.");
    if (!body.email && !body.phone) return showError("Please give an email address or a WhatsApp number so we can reply.");
    if (body.email && !EMAIL_RE.test(body.email)) return showError("That email address doesn't look right. Please check it.");
    if (body.message.length < 5) return showError("Please write your message.");

    const btn = $("contactBtn");
    btn.disabled = true; btn.textContent = "Sending...";
    try {
      const r = await fetch("/api/contact", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin",
      });
      let d = {};
      try { d = await r.json(); } catch {}
      if (r.ok) showDone(d, body);
      else showError(d.error || "Something went wrong. Please try again, or use WhatsApp or email above.");
    } catch {
      showError("Couldn't send your message. Check your connection, or use WhatsApp or email above.");
    }
    btn.disabled = false; btn.textContent = "Send message";
  });

  function showDone(d, body) {
    $("contactForm").hidden = true;
    $("contactDone").hidden = false;
    $("doneRef").textContent = "Reference " + d.id;
    const note = $("doneNote"), actions = $("doneActions");
    actions.textContent = "";
    const first = body.name.split(/\s+/)[0];
    const replyTo = body.email || body.phone;
    const hasDirect = !!(d.whatsappUrl || d.emailUrl);
    if (d.notified) {
      $("doneTitle").textContent = "Message sent";
      note.className = "alert alert-ok";
      note.textContent = "Thank you, " + first + ". " + (agent === "us" ? "We have" : agent + " has") + " your message and will reply to " + replyTo + "." +
        (d.whatsappUrl ? " Need a quicker answer? Send it on WhatsApp too." : "");
      if (d.whatsappUrl) actions.appendChild(linkBtn("Send on WhatsApp too", d.whatsappUrl, "btn-ghost"));
    } else {
      $("doneTitle").textContent = hasDirect ? "One last step" : "Message saved";
      note.className = "alert alert-info";
      note.textContent = hasDirect
        ? "Thank you, " + first + ". Your message is saved. Tap WhatsApp or Email below to send it to " + (agent === "us" ? "us" : agent) + ". It's already written, so you only need to press send."
        : "Thank you, " + first + ". Your message is saved and will be read soon.";
      if (d.whatsappUrl) actions.appendChild(linkBtn("Send on WhatsApp", d.whatsappUrl, "btn-brass"));
      if (d.emailUrl) actions.appendChild(linkBtn("Send by email", d.emailUrl, d.whatsappUrl ? "btn-ghost" : "btn-brass"));
    }
    $("contactDone").scrollIntoView({ block: "start", behavior: "smooth" });
  }

  $("another").onclick = () => {
    $("c-message").value = "";
    $("contactDone").hidden = true;
    $("contactForm").hidden = false;
    $("c-message").focus();
  };
})();
