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

  // -----------------------------------------------------------------------
  // SAFETY BRIEFING (PHASE 1.5) — a short, fixed-timing sequence of
  // caption + gaze + highlight steps that plays once per page load, right
  // when the student enters the lab. It runs on its own timer rather than
  // trying to sync to the narration audio's exact waveform (we have no
  // transcript/timestamps for welcome.mp3.mp3), so the captions are a
  // short *summary* of what the teacher is saying, not a literal
  // transcript — intentionally short so they never cover the screen.
  // `item` must match a key on the safetyItems object handed to
  // onAvatarLoaded() (see enviroment_lab_with_avatar_1(3).html).
  // -----------------------------------------------------------------------
  const SAFETY_SEQUENCE = [
    { item: null, ms: 4200,
      ar: "أهلاً بك في مختبر الكيمياء الغامر، دعني أطلعك أولًا على معدات السلامة.",
      en: "Welcome to the Immersive Chemistry Lab — first, let's go over the safety gear." },
    { item: "coats", ms: 4200,
      ar: "هذا معطف المختبر، يحميك من انسكاب المواد الكيميائية.",
      en: "This is the lab coat — it protects you from chemical spills." },
    { item: "gloves", ms: 4200,
      ar: "ترتدي القفازات لحماية يديك عند التعامل مع المواد.",
      en: "Wear the gloves to protect your hands when handling substances." },
    { item: "goggles", ms: 4200,
      ar: "النظارات الواقية تحمي عينيك من الرذاذ والأبخرة.",
      en: "Safety goggles protect your eyes from splashes and fumes." },
    { item: "extinguisher", ms: 4200,
      ar: "وطفاية الحريق موجودة هنا لأي طارئ، تذكّر مكانها دائمًا.",
      en: "The fire extinguisher is here for emergencies — remember where it is." },
    { item: null, ms: 4800,
      ar: "الآن ارتدِ معدات السلامة، أصبحت جاهزًا لبدء التدريب. اختر أحد الأبواب الثلاثة لتبدأ.",
      en: "Now put on your safety gear — you're ready to start. Choose one of the three doors to begin." }
  ];
  const HIGHLIGHT_COLOR = 0xF59E0B; // matches --gold on the main page
  const HIGHLIGHT_INTENSITY = 0.9;

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

  // -- safety briefing state --
  let teacherAvatarRef = null;
  let defaultQuaternion = null;   // avatar's at-load orientation (facing the students) — restored after each highlight
  let briefingScene = null;       // THREE.Scene, handed in via onAvatarLoaded's 4th arg
  let safetyItemsRef = null;      // { coats, gloves, goggles, extinguisher }
  let avatarReady = false;
  let labEntered = false;
  let briefingStarted = false;
  let briefingTimer = null;
  let highlightKey = null;
  let highlightLight = null;
  const emissiveBackup = new WeakMap(); // material -> { color, intensity }, restored when un-highlighted

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
    /* Short teacher caption — a brief summary, never a full transcript, so
       it never covers the screen. Fades in/out between briefing steps. */
    #teacherCaption{
      position:absolute; left:50%; bottom:16%; transform:translateX(-50%); translate:-50% 0;
      max-width:min(560px,86vw); text-align:center; pointer-events:none;
      background:rgba(15,23,42,.82); border:1px solid rgba(245,158,11,.45);
      border-radius:14px; padding:10px 18px; font-family:var(--ar,system-ui);
      font-size:15px; color:var(--ink,#E8EEF7); opacity:0; transition:opacity .25s ease;
    }
    #teacherCaption.show{ opacity:1; }
    #teacherCaption .en{
      display:block; margin-top:3px; font-size:12px; color:#fcd34d;
      font-family:var(--en,system-ui); direction:ltr;
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

  const captionEl = document.createElement("div");
  captionEl.id = "teacherCaption";
  if(hud) hud.appendChild(captionEl);

  function showCaption(ar, en){
    captionEl.innerHTML = ar + (en ? '<span class="en">' + en + '</span>' : '');
    captionEl.classList.add("show");
  }
  function hideCaption(){
    captionEl.classList.remove("show");
  }

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

  function onAvatarLoaded(avatar, mixer, animations, context){
    console.info("[TeacherAssistant] onAvatarLoaded called — teacher_character.glb finished loading, safetyItems=", !!(context && context.safetyItems));
    teacherMixer = mixer;
    teacherAvatarRef = avatar;
    if(avatar) defaultQuaternion = avatar.quaternion.clone();
    if(context){
      briefingScene = context.scene || null;
      safetyItemsRef = context.safetyItems || null;
    }
    avatarReady = true;
    maybeStartBriefing();

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
  // SAFETY BRIEFING — gaze + soft highlight on the safety-station items,
  // paced by SAFETY_SEQUENCE above rather than the audio track (see the
  // comment on SAFETY_SEQUENCE for why). Never touches the equipment's own
  // geometry/material colors permanently — it only nudges emissive color/
  // intensity while highlighted and restores the original afterward, plus
  // an accompanying THREE.PointLight for materials that ignore emissive.
  // -----------------------------------------------------------------------
  function lookAtWorldPosition(vec3){
    if(!teacherAvatarRef) return;
    const THREE = window.THREE;
    if(!THREE) return;
    const avatarWorldPos = new THREE.Vector3();
    teacherAvatarRef.getWorldPosition(avatarWorldPos);
    // keep the target level with the avatar so it's a pure yaw turn, not a whole-body tilt
    teacherAvatarRef.lookAt(vec3.x, avatarWorldPos.y, vec3.z);
  }

  function lookAtItem(key){
    if(!safetyItemsRef || !safetyItemsRef[key] || !window.THREE) return;
    const worldPos = new window.THREE.Vector3();
    safetyItemsRef[key].getWorldPosition(worldPos);
    lookAtWorldPosition(worldPos);
  }

  function lookAtStudent(){
    // Restores the same orientation the main script already computed at
    // load time (facing back across the room toward the students/doors) —
    // see the "TeacherAvatar ... lookAt(doorCenterTarget)" comment in
    // enviroment_lab_with_avatar_1(3).html.
    if(teacherAvatarRef && defaultQuaternion) teacherAvatarRef.quaternion.copy(defaultQuaternion);
  }

  function setEmissive(object, on){
    object.traverse((node)=>{
      const mats = Array.isArray(node.material) ? node.material : (node.material ? [node.material] : []);
      mats.forEach((m)=>{
        if(!m || !m.emissive) return; // MeshBasicMaterial etc. — skip, the point light below still helps
        if(on){
          if(!emissiveBackup.has(m)) emissiveBackup.set(m, { color: m.emissive.clone(), intensity: m.emissiveIntensity || 0 });
          m.emissive.set(HIGHLIGHT_COLOR);
          m.emissiveIntensity = HIGHLIGHT_INTENSITY;
        } else if(emissiveBackup.has(m)){
          const orig = emissiveBackup.get(m);
          m.emissive.copy(orig.color);
          m.emissiveIntensity = orig.intensity;
          emissiveBackup.delete(m);
        }
      });
    });
  }

  function clearHighlight(){
    if(highlightKey && safetyItemsRef && safetyItemsRef[highlightKey]) setEmissive(safetyItemsRef[highlightKey], false);
    if(highlightLight && briefingScene) briefingScene.remove(highlightLight);
    highlightLight = null;
    highlightKey = null;
  }

  function setHighlight(key){
    clearHighlight();
    if(!key || !safetyItemsRef || !safetyItemsRef[key] || !window.THREE || !briefingScene) return;
    const THREE = window.THREE;
    highlightKey = key;
    setEmissive(safetyItemsRef[key], true);
    const worldPos = new THREE.Vector3();
    safetyItemsRef[key].getWorldPosition(worldPos);
    highlightLight = new THREE.PointLight(HIGHLIGHT_COLOR, 1.1, 2.4, 2);
    highlightLight.position.set(worldPos.x, worldPos.y + 0.3, worldPos.z);
    briefingScene.add(highlightLight);
  }

  function maybeStartBriefing(){
    if(briefingStarted || !avatarReady || !labEntered) return;
    briefingStarted = true;
    console.info("[TeacherAssistant] starting safety briefing");
    setState("SPEAKING");
    runBriefingStep(0);
  }

  // Safety net: if teacher_character.glb is slow, blocked, or fails to load
  // for any reason, avatarReady would never flip true and the briefing
  // (and therefore the door lock in enviroment_lab_with_avatar_1(3).html)
  // would never resolve, permanently trapping the student in the lobby.
  // Force the briefing to start a few seconds after entry regardless —
  // it just runs without turning the avatar's gaze if it isn't loaded yet.
  function forceStartBriefing(){
    if(briefingStarted) return;
    avatarReady = true;
    maybeStartBriefing();
  }

  function runBriefingStep(i){
    if(i >= SAFETY_SEQUENCE.length){
      finishBriefing();
      return;
    }
    const step = SAFETY_SEQUENCE[i];
    showCaption(step.ar, step.en);
    if(step.item){ lookAtItem(step.item); setHighlight(step.item); }
    else { lookAtStudent(); clearHighlight(); }
    briefingTimer = window.setTimeout(()=> runBriefingStep(i + 1), step.ms);
  }

  function finishBriefing(){
    hideCaption();
    clearHighlight();
    lookAtStudent();
    // Only drop back to IDLE if the narration audio (if any) has already
    // finished too — its own "ended" handler also calls setState("IDLE"),
    // so this is a harmless no-op in that case, and a safety net if the
    // audio was blocked/missing.
    if(currentState !== "LISTENING" && currentState !== "THINKING" && currentState !== "ANSWERING") setState("IDLE");
    window.dispatchEvent(new CustomEvent("teacher-ready-for-training"));
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
    console.info("[TeacherAssistant] notifyEnterDesktop called");
    labEntered = true;
    maybeStartBriefing();
    window.setTimeout(forceStartBriefing, 6000);
    attemptPlayNarration();
  }

  function notifyEnterVR(){
    // Called synchronously at the very top of enterVR(), inside the same
    // click handler that goes on to request the WebXR session — still
    // within the user gesture, so autoplay is far more likely to be
    // allowed here than on the automatic desktop entry above. DOM buttons
    // aren't visible inside a headset, but audio started here plays fine.
    labEntered = true;
    maybeStartBriefing();
    window.setTimeout(forceStartBriefing, 6000);
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
