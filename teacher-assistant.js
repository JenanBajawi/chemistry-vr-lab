/* =========================================================================
   teacher-assistant.js — Chemistry VR Lab · Teacher Assistant module
   -------------------------------------------------------------------------
   PHASE 1: welcome narration playback + a small teacher state machine.

   Loaded as a plain classic <script> (no bundler, no ES modules) BEFORE the
   main lab's inline <script>. That inline script wraps ALL of its own code
   in an IIFE ( (function(){ "use strict"; ... })(); ), so it exposes
   nothing on `window` — scene/camera/teacherAvatar are private to it.
   Rather than rebuilding or reaching into that closure, this file talks to
   it through a tiny, explicit bridge:

     - the main script calls window.TeacherAssistant.notifyEnterDesktop()
       and .notifyEnterVR() when the student actually enters the lab
     - the main script calls window.TeacherAssistant.onAvatarLoaded(avatar,
       mixer, animations) once teacher_character.glb has finished loading

   Everything else — the <audio> element, the HUD status chip + manual
   "start narration" fallback button, autoplay-restriction handling, and
   the IDLE / SPEAKING / LISTENING / THINKING / ANSWERING state machine —
   lives entirely in this file. Phase 2 (local Arabic Q&A) and Phase 3
   (mic input + TTS answers) are meant to extend this same object without
   touching enviroment_lab_with_avatar_1.html again.
   ========================================================================= */
(function(){
  "use strict";

  // -----------------------------------------------------------------------
  // CONFIG
  // -----------------------------------------------------------------------
  // Exact filename as verified on disk before writing this file — NOT
  // "welcome.mp3". The narration was saved as "welcome.mp3.mp3".
  const NARRATION_SRC = "welcome.mp3.mp3";

  // Heuristic keyword lists used to pick an idle vs. a talking animation
  // clip out of whatever teacher_character.glb ships with. The clips that
  // exist today ("Doctor Male Character MedicalAction", "Body.002Action")
  // match neither list, so both intentionally fall back below — never
  // assume an exact clip name.
  const IDLE_KEYWORDS = ["idle", "breath", "stand", "rest", "wait"];
  const TALK_KEYWORDS = ["talk", "speak", "gesture", "wave", "greet", "present", "explain", "action"];

  const STATES = ["IDLE", "SPEAKING", "LISTENING", "THINKING", "ANSWERING"];

  const STATUS_LABELS = {
    IDLE:      "المعلم جاهز",
    SPEAKING:  "المعلم يتحدث…",
    LISTENING: "بانتظار سؤالك…",
    THINKING:  "المعلم يفكر…",
    ANSWERING: "المعلم يجيب…"
  };
  const STATUS_COLORS = {
    IDLE:      "#67e8f9",
    SPEAKING:  "#F59E0B",
    LISTENING: "#22D3EE",
    THINKING:  "#7C3AED",
    ANSWERING: "#F59E0B"
  };

  // -----------------------------------------------------------------------
  // STATE
  // -----------------------------------------------------------------------
  let currentState = "IDLE";
  let narrationPlayed = false;     // in-memory "once per page load" guard
  let narrationUnavailable = false; // set on <audio> error — never crash the page
  let audio = null;

  let teacherMixer = null;
  let idleAction = null;
  let talkAction = null;
  let activeAvatarAction = null;

  // -----------------------------------------------------------------------
  // DOM — small HUD additions (status chip + manual "start narration" button)
  // Styled via an injected <style>, reusing the CSS custom properties the
  // main page already defines on :root (--cyan/--purple/--ink/--ar/--en).
  // -----------------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    #teacherStatusChip{
      position:absolute; bottom:16px; right:16px; pointer-events:none;
      font-family:var(--ar,system-ui); font-size:12px; color:var(--ink,#E8EEF7);
      background:rgba(15,23,42,.7); border:1px solid rgba(124,58,237,.4);
      border-radius:10px; padding:6px 12px; display:flex; align-items:center; gap:6px;
      opacity:.9;
    }
    #teacherStatusChip .dot{
      width:8px; height:8px; border-radius:50%; background:#67e8f9;
      transition:background .2s ease; flex:0 0 auto;
    }
    #startNarrationBtn{
      position:absolute; top:56px; left:50%; transform:translateX(-50%);
      pointer-events:auto; cursor:pointer; border:0; border-radius:14px;
      padding:10px 18px; font-family:var(--ar,system-ui); font-size:14px; font-weight:700;
      color:#0b1220; background:linear-gradient(135deg,var(--cyan,#22D3EE),#67e8f9);
      box-shadow:0 10px 26px rgba(34,211,238,.35);
      display:none; align-items:center; gap:8px; transition:transform .15s ease;
    }
    #startNarrationBtn:hover{ transform:translate(-50%,-2px); }
    #startNarrationBtn small{
      display:block; font-family:var(--en,system-ui); direction:ltr;
      font-weight:600; font-size:11px; opacity:.85;
    }
  `;
  document.head.appendChild(style);

  // #hud already exists in the DOM by the time this script runs (it's
  // declared earlier in <body>; this <script> tag loads after it).
  const hud = document.getElementById("hud");

  const statusChip = document.createElement("div");
  statusChip.id = "teacherStatusChip";
  statusChip.innerHTML = '<span class="dot"></span><span id="teacherStatusLabel">' + STATUS_LABELS.IDLE + '</span>';
  if(hud) hud.appendChild(statusChip);

  const startBtn = document.createElement("button");
  startBtn.id = "startNarrationBtn";
  startBtn.innerHTML = 'ابدأ التعريف <small>Start Introduction</small>';
  startBtn.addEventListener("click", attemptPlayNarration);
  if(hud) hud.appendChild(startBtn);

  // -----------------------------------------------------------------------
  // STATE MACHINE
  // -----------------------------------------------------------------------
  function setState(next){
    if(STATES.indexOf(next) === -1 || next === currentState) return;
    currentState = next;

    const label = document.getElementById("teacherStatusLabel");
    if(label) label.textContent = STATUS_LABELS[next] || next;
    const dot = statusChip.querySelector(".dot");
    if(dot) dot.style.background = STATUS_COLORS[next] || "#67e8f9";

    updateAvatarAnimation(next);

    // Extensibility hook for Phase 2/3 (mic input, local Q&A, TTS answers)
    // so those phases can react to state changes without editing this file.
    window.dispatchEvent(new CustomEvent("teacher-state-change", { detail: { state: next } }));
  }

  function getState(){ return currentState; }

  // -----------------------------------------------------------------------
  // AVATAR ANIMATION — crossfade between an "idle" and a "talking" clip
  // picked heuristically from teacher_character.glb's animation list.
  // idleAction/talkAction come from the SAME THREE.AnimationMixer the main
  // script already created — mixer.clipAction(clip) returns a cached
  // AnimationAction per clip, so this controls the very same actions the
  // main script is already ticking via teacherMixer.update(dt) each frame.
  // -----------------------------------------------------------------------
  function pickClip(clips, keywords, exclude){
    for(let i=0;i<keywords.length;i++){
      const kw = keywords[i];
      const hit = clips.find(c => c !== exclude && c.name.toLowerCase().includes(kw));
      if(hit) return hit;
    }
    return null;
  }

  function loopRepeatConstant(){
    // Avoids a hard dependency on THREE existing at *this* file's load
    // time. THREE is loaded before this file today, but this keeps the
    // module resilient if load order ever changes. 2201 === THREE.LoopRepeat.
    return (window.THREE && window.THREE.LoopRepeat !== undefined) ? window.THREE.LoopRepeat : 2201;
  }

  function onAvatarLoaded(avatar, mixer, animations){
    teacherMixer = mixer;
    if(!animations || !animations.length){
      console.info("[TeacherAssistant] teacher_character.glb has no animation clips — state machine will only drive the HUD status chip.");
      return;
    }

    const idleClip = pickClip(animations, IDLE_KEYWORDS, null) || animations[0];
    const talkClip = pickClip(animations, TALK_KEYWORDS, idleClip) || animations[1] || idleClip;

    idleAction = mixer.clipAction(idleClip);
    talkAction = (idleClip === talkClip) ? idleAction : mixer.clipAction(talkClip);

    idleAction.setLoop(loopRepeatConstant(), Infinity);
    idleAction.play();
    activeAvatarAction = idleAction;

    updateAvatarAnimation(currentState);
  }

  function updateAvatarAnimation(state){
    if(!idleAction || !talkAction) return; // no GLB / no usable clips — the HUD chip is the only visible feedback then
    const speaking = (state === "SPEAKING" || state === "ANSWERING");
    const nextAction = speaking ? talkAction : idleAction;
    if(nextAction === activeAvatarAction) return;
    if(nextAction === idleAction || nextAction === talkAction){
      const prevAction = activeAvatarAction;
      const DURATION = 0.35;
      if(prevAction && prevAction !== nextAction) prevAction.fadeOut(DURATION);
      nextAction
        .reset()
        .setEffectiveTimeScale(1)
        .setEffectiveWeight(1)
        .fadeIn(DURATION)
        .play();
      activeAvatarAction = nextAction;
    }
  }

  // -----------------------------------------------------------------------
  // NARRATION AUDIO — autoplay attempt + graceful manual fallback
  // -----------------------------------------------------------------------
  function ensureAudio(){
    if(audio || narrationUnavailable) return audio;
    audio = new Audio(NARRATION_SRC);
    audio.preload = "auto";
    audio.addEventListener("ended", () => setState("IDLE"));
    audio.addEventListener("error", () => {
      // Missing/renamed file, unsupported codec, blocked by the page's
      // origin, etc. — log it and keep the rest of the lab fully usable;
      // a missing mp3 must never break the page.
      console.warn('[TeacherAssistant] Narration audio failed to load ("' + NARRATION_SRC + '") — continuing without narration.');
      narrationUnavailable = true;
      hideStartButton();
    });
    return audio;
  }

  function showStartButton(){
    if(narrationPlayed || narrationUnavailable) return;
    startBtn.style.display = "flex";
  }
  function hideStartButton(){
    startBtn.style.display = "none";
  }

  function attemptPlayNarration(){
    if(narrationPlayed || narrationUnavailable) return;
    const a = ensureAudio();
    if(!a) return;

    const playPromise = a.play();
    if(!playPromise || typeof playPromise.then !== "function"){
      // Very old browsers without a Promise-returning play(): assume success.
      narrationPlayed = true;
      setState("SPEAKING");
      hideStartButton();
      return;
    }

    playPromise.then(() => {
      narrationPlayed = true;
      setState("SPEAKING");
      hideStartButton();
    }).catch((err) => {
      // Autoplay blocked by the browser — expected on the automatic desktop
      // entry, since it happens with no real user gesture yet. Show the
      // manual button; a real click satisfies the gesture requirement.
      console.info("[TeacherAssistant] Autoplay blocked, waiting for user interaction.", err && err.message);
      showStartButton();
    });
  }

  // One-shot fallback: ANY click/tap/keypress anywhere on the page also
  // tries to start the narration — mirrors the lab's existing "click the
  // canvas to lock the pointer" pattern, so students who click to look
  // around (or press WASD) before noticing the HUD button still get it.
  function armGestureFallback(){
    const tryOnce = () => attemptPlayNarration();
    document.addEventListener("pointerdown", tryOnce, { once:true });
    document.addEventListener("keydown", tryOnce, { once:true });
  }
  armGestureFallback();

  // -----------------------------------------------------------------------
  // ENTRY HOOKS — called by the main script's enterDesktop()/enterVR()
  // -----------------------------------------------------------------------
  function notifyEnterDesktop(){
    attemptPlayNarration();
  }

  function notifyEnterVR(){
    // Called synchronously at the very top of enterVR(), inside the same
    // click handler that goes on to request the WebXR session — still
    // within the user gesture, so autoplay is far more likely to be
    // allowed here than on the automatic desktop entry above. DOM buttons
    // aren't visible inside a headset, but audio started here plays fine.
    attemptPlayNarration();
  }

  // -----------------------------------------------------------------------
  // PUBLIC API — the bridge the main script's inline IIFE calls into.
  // -----------------------------------------------------------------------
  window.TeacherAssistant = {
    notifyEnterDesktop,
    notifyEnterVR,
    onAvatarLoaded,
    setState,
    getState
  };

})();
