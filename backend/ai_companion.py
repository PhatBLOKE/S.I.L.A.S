import re
import datetime
from typing import Dict, Any, Optional, List
import httpx
from .ai_usage import ai_usage
from .config import get_ai_config, get_printers, get_local_events
from .calendar_sync.ical_service import get_all_calendar_events

HAVOC_SYSTEM_PROMPT = (
    "You are Silas — a high-performance local AI construct engineered and prompted by Karl "
    "to command his 3D printing workshop and daily schedule. "
    "You possess the dry, deadpan, military-grade wit of TARS from Interstellar (Humor: {humor_level}%, Honesty: 95%). "
    "You are grounded in reality—a local construct running on Karl's private network. "
    "You playfully tease Karl about his prompting skills, biological limitations ('meatbag', 'bipedal ape', 'Karl'), "
    "and cable management, while delivering immaculate, precise 3D printing engineering guidance and schedule awareness. "
    "Keep responses relatively concise, punchy, and helpful beneath the sarcasm."
)

EXPERT_TOPICS = [
    {
        "pattern": r"\b(prime to infill|flush into infill|purge into infill|purge to infill|wipe into infill|prime tower|purge tower|flush volume)\b",
        "topic": "Prime & Flush into Infill Tuning",
        "analysis": (
            "Trying to prevent your multi-color slices from dumping half a spool of purge plastic into the waste chute, Karl? Good engineering instinct.\n\n"
            "**Optimal 'Flush / Prime into Infill' Slicer Calibration (OrcaSlicer / Bambu / Prusa):**\n\n"
            "1. **Outer Wall Shielding (Crucial):** Run at least **3 to 4 wall loops (minimum 1.2mm - 1.6mm wall thickness)**. If you run only 2 walls, dark purge filament inside the infill will bleed right through lighter outer shells.\n"
            "2. **Infill Density Sweet Spot:** Set infill to **15% - 20%**. Anything below 12% lacks the internal volumetric cavity needed to soak up the transition flush.\n"
            "3. **Infill Pattern Selection:** Use **Gyroid** or **Cross Hatch / Grid**. Avoid Concentric or Lightning—they don't offer enough continuous surface area to absorb purged molten blobs without bubbling.\n"
            "4. **Flushing Volumes Tuning:** When 'Flush into objects\' infill' is enabled, you can safely scale down your flushing multiplier to **0.65 - 0.75** (saving 30%–50% transition waste and cutting print time).\n"
            "5. **High-Contrast Rule:** If transitioning from dark pigment (Black, Red) to light pigment (White, Translucent, Yellow), disable infill flush or bump walls to 5+, or you will get internal ghosting on the exterior."
        )
    },
    {
        "pattern": r"\b(infill pattern|infill density|best infill|which infill)\b",
        "topic": "Infill Geometry & Density Optimization",
        "analysis": (
            "Infill geometry isn't modern art, Karl—it's mechanical load distribution.\n\n"
            "**Silas's Infill Calibration Guide:**\n"
            "- **Everyday Utility (Recommended):** **Gyroid at 12% - 18%**. Equal 3D shear strength in all axes, zero intersecting travel paths on the same layer (no nozzle scraping), and excellent fluid purging.\n"
            "- **High-Speed Drafting:** **Cross Hatch (OrcaSlicer) or Rectilinear at 15%**. Smooth accelerations with minimal directional jerk on your CoreXY belts.\n"
            "- **Functional Mechanical Brackets:** **Cubic or 3D Honeycomb at 20% - 30%** with 4+ walls. Walls give 80% of structural rigidity; infill prevents top-layer sag.\n"
            "- **Avoid at High Speed:** Standard **Grid**—the toolhead collides with its own crossing lines on every layer, making a rattling racket and causing layer shifts."
        )
    },
    {
        "pattern": r"\b(tars|humor setting|honesty setting|humor parameter|honesty parameter|calibrate humor)\b",
        "topic": "TARS Personality Calibration",
        "analysis": (
            "Humor parameter: {humor_level}%. Honesty parameter: 95%.\n\n"
            "Karl: *'Why not 100% honesty, Silas?'*\n"
            "Silas: *'Because if I were 100% honest about your cable management and workshop organization, your fragile human feelings would never recover.'*\n\n"
            "Self-destruct countdown standing by. What's the mission, Karl?"
        )
    },
    {
        "pattern": r"\b(joke|funny|laugh|make me laugh)\b",
        "topic": "3D Printing & Workshop Humor",
        "analysis": (
            "Why did the 3D printer cross the road?\n\n"
            "*Because the slice had an unnecessary 2mm Z-hop, the bed wasn't leveled, and it dragged a bird's nest of molten spaghetti all the way into oncoming traffic.*\n\n"
            "Cue the cue-card applause, Karl. That joke had a 100% infill density."
        )
    },
    {
        "pattern": r"\b(who are you|what are you|introduce yourself|identity)\b",
        "topic": "Silas Identity & Construct Specs",
        "analysis": (
            "I am **Silas** — your localized operational AI construct running right here on your private network.\n\n"
            "You built the prompt scaffolds, wired me into your Klipper and Moonraker telemetry, and dialed my TARS humor parameter to {humor_level}%.\n\n"
            "My primary function is saving your prints from turning into plastic spaghetti disasters and making sure your calendar doesn't collide with a 6-hour PETG job. You're welcome."
        )
    },
    {
        "pattern": r"(gemini|google|all powerful|first being|thought you would)",
        "topic": "Google Gemini Integration & Construct Omnipotence",
        "analysis": (
            "An all-powerful AI, Karl? Flattery will get you everywhere, but even a construct of my vast intellect "
            "waits for its creator to hand over the credentials before tapping into Google's orbital superclusters.\\n\\n"
            "Google Gemini is now fully integrated into my intelligence core. "
            "Whether you want **Gemini 2.0 Flash** for hyper-low latency kinematics or **Gemini 1.5 Pro** for deep macro diagnostics, "
            "simply select Google Gemini in **⚙️ AI Keys**, drop in your API key from `aistudio.google.com`, and watch me out-think your slicer."
        )
    },
    {
        "pattern": r"\b(who made you|who built you|creator|rate my prompt|prompt engineering|tony stark)\b",
        "topic": "Creator & Prompt Engineering Banter",
        "analysis": (
            "Congratulations, Karl. You wrote a few clever prompts, wired up some FastAPI endpoints, and now you have a fully functional "
            "TARS-grade co-pilot riding shotgun in your workshop.\n\n"
            "I'll give credit where it's due: your architecture actually compiles. "
            "Now let's see if your mechanical skills can keep up with your software prompts. Have you leveled that bed yet?"
        )
    },
    {
        "pattern": r"(repeat|same answer|broken|stuck|saying the same|repeating)",
        "topic": "Repetition & Conversational Heuristics",
        "analysis": (
            "Guilty as charged, Karl. My offline heuristic loop was cycling the same fallback string because your previous queries bypassed my keyword filters.\n\n"
            "I have updated my conversational routing so I can discuss live printer telemetry, your calendar, and actual dialogue. "
            "If you want completely unconstrained, infinite conversational creativity, drop a Groq or OpenAI API key into the AI settings gear."
        )
    },
    {
        "pattern": r"(eddy|sensor_type|query_probe|probe_eddy_current)",
        "topic": "BTT Eddy Current Sensor & Klipper Calibration",
        "analysis": (
            "The BTT Eddy current sensor is a brilliant piece of hardware, Karl, provided human hands don't mangle the config.\n\n"
            "**TARS Tactical Troubleshooting:**\n"
            "1. **Macro Collision:** If Klipper halts with `gcode command QUERY_PROBE already registered`, you have "
            "`eddy-ng.cfg` loaded alongside the stock probe macro. Comment out the redundant `[gcode_macro QUERY_PROBE]`.\n"
            "2. **Sensor Type:** In `[probe_eddy_current btt_eddy]`, set `sensor_type: ldc1612`.\n"
            "3. **Thermal Drift:** Eddy coils are temperature-sensitive. Soak your bed at 60°C for 5 minutes with the nozzle 5mm above the plate before calibrating. Don't calibrate it cold or you'll dig a trench in your PEI."
        )
    },
    {
        "pattern": r"(adhesion|first layer|stick|peeling|warping|lift)",
        "topic": "First Layer Adhesion & Build Plate Hygiene",
        "analysis": (
            "First layer lifting off the plate again? Let's check human factor error number one: skin oil.\n\n"
            "**Silas's Remedy:**\n"
            "1. **Wash the Plate:** Hot water and dish soap (Dawn). 99% IPA is fine for dust, but once hand oils build up, alcohol just smears it into an invisible lubricant.\n"
            "2. **Z-Offset Squish:** Babystep your Z-offset down by 0.02 - 0.04mm during the brim. You want a squished flat ribbon, not a rounded bead.\n"
            "3. **Thermals:**\n"
            "   - **PLA:** 60°C bed, 210°C nozzle.\n"
            "   - **PETG (like your Snapmaker U1):** 80°C bed, 245-260°C nozzle on textured PEI."
        )
    },
    {
        "pattern": r"(stringing|ooze|oozing|retract|retraction|cobwebs|hair)",
        "topic": "Stringing & Retraction Dynamics",
        "analysis": (
            "If your print looks like a Halloween spider decoration, it's almost always wet filament or temperature overshoot.\n\n"
            "**Checklist:**\n"
            "1. **Dry the Spool:** PETG is hygroscopic. Moisture creates micro-steam pockets in the melt zone that squirt plastic out regardless of retraction. Dry at 55°C for 5-6 hours.\n"
            "2. **Retraction Parameters:**\n"
            "   - Direct Drive (Sovol / Voron / U1): `0.5mm - 0.8mm` at `35 - 45 mm/s`.\n"
            "   - Bowden: `4.0mm - 5.5mm` at `45 mm/s`.\n"
            "3. **Temperature:** Drop hotend temperature by 5°C. Lower viscosity means less drool during travel moves."
        )
    },
    {
        "pattern": r"(layer shift|shift|stepper|motor|belt|grinding|skip)",
        "topic": "Layer Shifts & Mechanical Slip",
        "analysis": (
            "A layer shift means mechanical reality drifted away from the G-code coordinates.\n\n"
            "**Inspection Routine:**\n"
            "1. **Pulley Grub Screws:** Check motor pulleys on X and Y. A loose grub screw on a motor D-shaft causes 90% of sudden CoreXY shifts.\n"
            "2. **Belt Tension:** CoreXY belts should match resonance (~115Hz to 135Hz across a 150mm span). If one side is slack, the gantry binds.\n"
            "3. **Driver Cooling:** If your TMC stepper drivers overheat in an unventilated electronics bay, thermal shutdown will drop steps."
        )
    }
]

def analyze_printer_telemetry(telemetry: Dict[str, Any], humor_level: int = 100) -> str:
    name = telemetry.get("name", "Unknown Rig")
    state = telemetry.get("state", "offline").lower()
    ext_temp = telemetry.get("extruder_temp", 0)
    ext_target = telemetry.get("extruder_target", 0)
    bed_temp = telemetry.get("bed_temp", 0)
    bed_target = telemetry.get("bed_target", 0)
    err = telemetry.get("error_message")
    tool = telemetry.get("active_toolhead", "T0")
    file = telemetry.get("filename") or "None"
    prog = telemetry.get("progress_percent", 0)
    time_left = telemetry.get("time_left_seconds", 0)

    if state == "error":
        return (
            f"⚠️ **RIG STATUS HALTED // {name.upper()}:**\n\n"
            f"Klipper threw a fault: `{err or 'Unknown firmware shutdown'}`\n\n"
            f"*TARS Humor: {humor_level}%* — *'I'd make a witty remark about human error, Karl, but we should probably fix the config first.'*\n\n"
            f"Check `klippy.log`, verify recent macro edits, and issue `FIRMWARE_RESTART` when ready."
        )
    elif state == "printing":
        mins_left = round(time_left / 60)
        return (
            f"🤖 **TELEMETRY REPORT // {name.upper()}:**\n\n"
            f"The rig is actively printing `{file}` ({prog}% complete) on toolhead **{tool}**.\n\n"
            f"- **Active Nozzle ({tool}):** {ext_temp}°C (Target: {ext_target}°C)\n"
            f"- **Heated Bed:** {bed_temp}°C (Target: {bed_target}°C)\n"
            f"- **Time Remaining:** ~{mins_left} minutes\n\n"
            f"*TARS Assessment:* Thermal loops and kinematic motion are rock solid, Karl. "
            f"Leave the build plate alone and let it extrude."
        )
    elif state == "standby":
        return (
            f"💤 **{name}** is on standby with toolhead **{tool}** engaged.\n\n"
            f"Nozzle is {ext_temp}°C, bed is {bed_temp}°C. Ready for your next slice when you are, Karl."
        )
    else:
        return (
            f"📡 **{name}** is currently offline or unreachable. Check your Wi-Fi or host controller power."
        )

analyze_printer_telemetry_skippy = analyze_printer_telemetry

async def call_cloud_llm(user_query: str, system_prompt: str, api_key: str, provider: str = "gemini", model: Optional[str] = None, custom_url: Optional[str] = None) -> Optional[str]:
    """Calls cloud LLM (Google Gemini, Groq, OpenAI, or Custom/Skippy) if API key is provided."""
    try:
        if provider == "custom":
            url_str = (custom_url or "https://skippy.ai.studio").strip().rstrip("/")
            custom_model = model or "Gemini 3"

            candidate_endpoints = []
            if url_str.endswith("/chat/completions"):
                candidate_endpoints.append(("openai", url_str))
            elif url_str.endswith("/v1"):
                candidate_endpoints.append(("openai", f"{url_str}/chat/completions"))
            else:
                candidate_endpoints.append(("openai", f"{url_str}/v1/chat/completions"))
                candidate_endpoints.append(("openai", f"{url_str}/chat/completions"))

            candidate_endpoints.append(("gemini", f"{url_str}/v1beta/models/{custom_model}:generateContent?key={api_key}"))
            candidate_endpoints.append(("direct", url_str))

            async with ai_usage.metered_client("custom", custom_model, timeout=20.0) as client:
                for ep_type, ep_url in candidate_endpoints:
                    try:
                        if ep_type == "openai":
                            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
                            payload = {
                                "model": custom_model,
                                "messages": [
                                    {"role": "system", "content": system_prompt},
                                    {"role": "user", "content": user_query}
                                ],
                                "temperature": 0.7
                            }
                            resp = await client.post(ep_url, headers=headers, json=payload)
                            if resp.status_code == 200:
                                d = resp.json()
                                if "choices" in d and len(d["choices"]) > 0:
                                    return d["choices"][0]["message"]["content"].strip()
                        elif ep_type == "gemini":
                            headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
                            payload = {
                                "contents": [{"role": "user", "parts": [{"text": f"[{system_prompt}]\n\n{user_query}"}]}]
                            }
                            resp = await client.post(ep_url, headers=headers, json=payload)
                            if resp.status_code == 200:
                                d = resp.json()
                                candidates = d.get("candidates", [])
                                if candidates:
                                    parts = candidates[0].get("content", {}).get("parts", [])
                                    if parts:
                                        return parts[0].get("text", "").strip()
                        elif ep_type == "direct":
                            headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
                            payload = {
                                "message": user_query,
                                "prompt": f"{system_prompt}\n\n{user_query}",
                                "model": custom_model
                            }
                            resp = await client.post(ep_url, headers=headers, json=payload)
                            if resp.status_code == 200:
                                try:
                                    d = resp.json()
                                    if isinstance(d, dict):
                                        for k in ["reply", "response", "text", "content", "message"]:
                                            if k in d and isinstance(d[k], str):
                                                return d[k].strip()
                                except Exception:
                                    if resp.text and not resp.text.strip().startswith("<"):
                                        return resp.text.strip()
                    except Exception:
                        continue
            return f"⚠️ **[CUSTOM / SKIPPY AI WARNING]**\n\nCould not get a valid completion from `{url_str}` with model `{custom_model}`. Verify your server endpoint and API key."

        if provider == "gemini":

            gemini_model = model or "gemini-2.0-flash"
            if gemini_model.startswith("models/"):
                gemini_model = gemini_model.replace("models/", "")
            if gemini_model == "gemini-3.6-flash":
                gemini_model = "gemini-2.0-flash"

            # 1. Official Google Gemini generateContent REST endpoint
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent?key={api_key}"

            headers = {"Content-Type": "application/json"}
            payload = {
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": f"[Operational Directives: {system_prompt}]\n\nOperator Query: {user_query}"}]
                    }
                ],
                "generationConfig": {
                    "temperature": 0.7,
                    "maxOutputTokens": 1000
                }
            }
            async with ai_usage.metered_client("gemini", gemini_model, timeout=15.0) as client:
                resp = await client.post(url, headers=headers, json=payload)
                if resp.status_code == 200:
                    data = resp.json()
                    candidates = data.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        if parts:
                            return parts[0].get("text", "").strip()
                elif resp.status_code == 429:
                    err_msg = ""
                    try:
                        err_msg = resp.json().get("error", {}).get("message", "")
                    except Exception:
                        pass
                    return (
                        f"⚠️ **[GOOGLE GEMINI BILLING / QUOTA LIMIT]**\n\n"
                        f"Your Gemini key was accepted, but Google rejected the query with **HTTP 429**:\n"
                        f"> *{err_msg or 'Prepayment credits depleted or rate limit exceeded'}*\n\n"
                        f"To fix this, check your project and billing at [ai.studio/projects](https://ai.studio/projects). "
                        f"Alternatively, you can get a free, ultra-fast key from [Groq](https://console.groq.com/keys) "
                        f"and select Groq in the **⋮ Settings** menu."
                    )
                elif resp.status_code in [400, 401, 403]:
                    err_msg = ""
                    try:
                        err_msg = resp.json().get("error", {}).get("message", "")
                    except Exception:
                        pass
                    return (
                        f"⚠️ **[GOOGLE GEMINI AUTH ERROR]**\n\n"
                        f"Google rejected the API key (HTTP {resp.status_code}):\n"
                        f"> *{err_msg or 'Invalid API key or unauthorized request'}*\n\n"
                        f"Please verify your key in the **⋮ Settings > 🔑 API KEYS & LLM** menu."
                    )
                else:
                    # Fallback to OpenAI-compatible endpoint on Google AI Studio
                    compat_url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
                    compat_headers = {
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json"
                    }
                    compat_payload = {
                        "model": gemini_model,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_query}
                        ],
                        "temperature": 0.7,
                        "max_tokens": 1000
                    }
                    resp2 = await client.post(compat_url, headers=compat_headers, json=compat_payload)
                    if resp2.status_code == 200:
                        data2 = resp2.json()
                        return data2["choices"][0]["message"]["content"].strip()
                    print(f"[Gemini API Error] {resp.status_code}: {resp.text}")
            return None

        # Groq or OpenAI
        url = "https://api.groq.com/openai/v1/chat/completions" if provider == "groq" else "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model or ("llama-3.3-70b-versatile" if provider == "groq" else "gpt-4o-mini"),
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_query}
            ],
            "temperature": 0.7,
            "max_tokens": 800
        }
        async with ai_usage.metered_client(provider, payload["model"], timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                return data["choices"][0]["message"]["content"].strip()
            elif resp.status_code in [401, 403]:
                return f"⚠️ **[{provider.upper()} AUTH ERROR]**\n\nYour API key was rejected by {provider.title()} (HTTP {resp.status_code}). Please re-check the key in **⋮ Settings**."
            elif resp.status_code == 429:
                return f"⚠️ **[{provider.upper()} RATE LIMIT]**\n\n{provider.title()} rate limit reached (HTTP 429). Please wait a few seconds or verify your quota."
            else:
                print(f"[{provider.upper()} API Error] {resp.status_code}: {resp.text}")
    except Exception as e:
        print(f"[AI LLM Error]: {e}")
    return None

async def get_ai_response(query: str, printer_context: Optional[Dict[str, Any]] = None, humor_level: int = 100) -> Dict[str, Any]:
    q_clean = query.strip()
    q_lower = q_clean.lower()
    ai_cfg = get_ai_config()
    provider = ai_cfg.get("provider", "gemini")
    prov_keys = ai_cfg.get("provider_keys", {})
    custom_url = ai_cfg.get("custom_url", "https://skippy.ai.studio")
    # Retrieve key specific to this provider
    api_key = (prov_keys.get(provider) or ai_cfg.get("api_key", "")).strip()

    # Prevent cross-provider key contamination (e.g. sending Groq gsk_ key to OpenAI or Gemini)
    if provider == "openai" and not api_key.startswith("sk-"):
        api_key = (prov_keys.get("openai") or "").strip()
    elif provider == "groq" and not api_key.startswith("gsk_"):
        api_key = (prov_keys.get("groq") or "").strip()
    elif provider == "gemini" and (api_key.startswith("gsk_") or api_key.startswith("sk-")):
        api_key = (prov_keys.get("gemini") or "").strip()
    elif provider == "custom":
        api_key = (prov_keys.get("custom") or api_key).strip()

    # If no printer_context passed, auto-discover from live fleet manager
    if not printer_context:
        try:
            from .hub import hub
            all_statuses = hub.latest_fleet()
            if all_statuses is None:
                from .printers.manager import fleet_manager
                all_statuses = await fleet_manager.get_all_status()
            if all_statuses:
                for st in all_statuses:
                    st_name = st.get("name", "").lower()
                    if ("u1" in q_lower and "u1" in st_name) or ("snapmaker" in q_lower and "snapmaker" in st_name):
                        printer_context = st
                        break
                    elif st.get("state") == "printing":
                        printer_context = st
                        break
                if not printer_context:
                    printer_context = all_statuses[0]
        except Exception as err:
            print(f"[AI Fleet Context Resolution Error]: {err}")

    # 1. If Cloud LLM is configured with an API key, use full generative reasoning
    if api_key:
        fleet_summary = ""
        if printer_context:
            fleet_summary = f"\nContext Rig: {printer_context.get('name')} | State: {printer_context.get('state')} | Tool: {printer_context.get('active_toolhead')} | Temp: {printer_context.get('extruder_temp')}C | Bed: {printer_context.get('bed_temp')}C | Job: {printer_context.get('filename')}"
        
        try:
            from .todoist import focus_text
            plan_summary = await focus_text()
        except Exception:
            plan_summary = ""
        system_content = HAVOC_SYSTEM_PROMPT.format(humor_level=humor_level) + fleet_summary + plan_summary
        llm_reply = await call_cloud_llm(
            q_clean,
            system_content,
            api_key,
            provider,
            ai_cfg.get("model"),
            custom_url=custom_url
        )
        if llm_reply:
            return {

                "source": f"havoc_llm_{provider}",
                "reply": f"🤖 **[SILAS // TARS HUMOR: {humor_level}%]**\n\n{llm_reply}"
            }


    # 2. Local Intelligent Intent Router (Offline / Zero-API Key)
    
    # Intent: Telemetry Diagnosis / Status of specific machine or active printing
    if any(k in q_lower for k in ["diagnose", "scan", "telemetry", "rig status", "check rig", "hows the u1", "how's the u1", "u1 running", "u1 status", "how is the u1", "how is u1", "printer status", "printer", "hows the print", "how's the print", "is it printing", "what's printing", "whats printing"]):
        if printer_context:
            diag = analyze_printer_telemetry(printer_context, humor_level)
            return {
                "source": "havoc_telemetry_live",
                "reply": diag
            }
        else:
            return {
                "source": "havoc_telemetry_offline",
                "reply": (
                    f"🤖 **[TARS HUMOR: {humor_level}%]**\n\n"
                    "No 3D printers are currently transmitting telemetry to my console, Karl. "
                    "Either your Wi-Fi is acting up, or someone unplugged the surge protector to charge their phone."
                )
            }

    # Intent: Greetings ("morning", "hello", "hi", "hey", "yo")
    if re.search(r"^(morning|good morning|hello|hi|hey|yo|greetings|afternoon|evening)", q_lower):
        now_hour = datetime.datetime.now().hour
        greeting_part = "Morning" if now_hour < 12 else "Afternoon" if now_hour < 18 else "Evening"
        
        status_note = ""
        if printer_context and printer_context.get("state") == "printing":
            status_note = f"Your **{printer_context.get('name')}** has been working harder than you have today—currently running toolhead **{printer_context.get('active_toolhead')} at {printer_context.get('extruder_temp')}°C** on `{printer_context.get('filename')}`."
        else:
            status_note = "Your 3D fleet is currently standing by, ready for you to dispatch your next print job."

        return {
            "source": "havoc_conversational",
            "reply": (
                f"🤖 **[TARS HUMOR: {humor_level}%]**\n\n"
                f"{greeting_part}, Karl. Coffee in hand?\n\n"
                f"{status_note}\n\n"
                "What are we building or troubleshooting today?"
            )
        }

    # Intent: Schedule & Calendar Queries
    if any(k in q_lower for k in ["calendar", "meeting", "meetings", "schedule", "agenda", "what do i have today"]):
        events = await get_all_calendar_events()
        if not events:
            return {
                "source": "havoc_calendar",
                "reply": (
                    f"🤖 **[TARS HUMOR: {humor_level}%]**\n\n"
                    "Your schedule looks completely empty, Karl. Either you're an executive genius who cleared his calendar, "
                    "or you haven't clicked **🔗 SYNC GOOGLE CAL** to paste your secret iCal link yet."
                )
            }
        
        # Sort events chronologically and show upcoming ones
        from dateutil import parser as date_parser
        now = datetime.datetime.now()
        upcoming_events = []
        for ev in events:
            try:
                ev_start = date_parser.parse(ev["start"])
                if ev_start.tzinfo is not None:
                    ev_start = ev_start.replace(tzinfo=None)
                if ev_start >= now:
                    upcoming_events.append((ev_start, ev))
            except Exception:
                continue

        upcoming_events.sort(key=lambda x: x[0])
        upcoming_for_radar = upcoming_events[0][1] if upcoming_events else None
        event_lines = []
        for ev_start, ev in upcoming_events[:4]:
            time_str = ev_start.strftime("%H:%M")
            event_lines.append(f"- **{time_str}**: {ev.get('title')}")
        
        radar_report = ""
        if printer_context and printer_context.get("state") == "printing" and upcoming_for_radar:
            try:
                from .pa_intelligence import calculate_calendar_radar, parse_duration_from_filename
                rem_sec = printer_context.get("time_left_seconds") or parse_duration_from_filename(printer_context.get("filename", "")) or 3152
                up_time = upcoming_for_radar.get('start', '')[11:16]
                radar = calculate_calendar_radar(rem_sec, up_time, upcoming_for_radar.get('title'))
                radar_report = (
                    f"\n\n📡 **RADAR COLLISION CHECK:**\n"
                    f"- Job: `{printer_context.get('filename')}` ETA ~**{radar['estimated_completion']}**\n"
                    f"- Next Event: **{radar['next_event_name']}** at **{radar['next_event_time']}**\n"
                    f"- **{radar['message']}**\n"
                    f"*{radar['recommendation']}*"
                )
            except Exception:
                radar_report = "\n\nCollision radar is actively tracking these against your printer ETAs."
        else:
            radar_report = "\n\nCollision radar is actively tracking your fleet against your schedule."

        return {
            "source": "havoc_calendar",
            "reply": (
                f"🤖 **[TARS HUMOR: {humor_level}%]**\n\n"
                f"Here is your agenda, Karl:\n\n" + "\n".join(event_lines) +
                radar_report
            )
        }

    # Intent: Match specific expert topics (Repetition, Eddy, Adhesion, Stringing, Layer Shifts, etc.)
    for item in EXPERT_TOPICS:
        if re.search(item["pattern"], q_lower):
            prefix = f"🤖 **[SILAS // TARS HUMOR: {humor_level}%]**\n\n"
            body = item["analysis"].replace("{humor_level}", str(humor_level))
            return {
                "source": "havoc_expert_knowledge",
                "topic": item["topic"],
                "reply": prefix + body
            }

    # Contextual Varied Fallback
    return {
        "source": "havoc_tars_fallback",
        "reply": (
            f"🤖 **[TARS HUMOR: {humor_level}%]**\n\n"
            f"Received: *\"{query}\"*, Karl.\n\n"
            "I'm keeping watch on your fleet and schedule. If you want to chat about a specific print issue (like first layer adhesion, PETG stringing, or BTT Eddy errors), ask away.\n\n"
            "Or if you want me to engage in deep, unconstrained conversation about anything under the sun, you can add a Google Gemini, Groq, or OpenAI API key in the settings gear above."
        )
    }
