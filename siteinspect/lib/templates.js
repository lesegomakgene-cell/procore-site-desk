// Built-in inspection checklists for a main contractor.
// Each template is a list of sections; each section a list of check items.
// Custom templates made in the app use the same shape and are stored in the db.

const T = (id, name, category, frequency, sections) => ({ id, name, category, frequency, builtIn: true, sections });
const S = (title, items) => ({ title, items });

const BUILT_IN_TEMPLATES = [
  T("weekly-hse", "Weekly site safety (HSE) inspection", "Safety", "Weekly", [
    S("Site set-up & access", [
      "Hoarding / perimeter fencing intact and gates secured",
      "Site rules, emergency numbers and mandatory signage displayed",
      "Visitor sign-in register in use",
      "All workers inducted (induction register up to date)",
      "PPE worn correctly by everyone on site",
      "Pedestrian and vehicle routes separated and marked",
    ]),
    S("Welfare", [
      "Toilets clean, adequate in number and serviced",
      "Clean drinking water available",
      "Eating / rest area clean and sheltered",
      "First aid box stocked and first aider on site",
    ]),
    S("Fire & emergency", [
      "Fire extinguishers in place, in date and unobstructed",
      "Emergency escape routes clear",
      "Assembly point signposted",
      "Hot work permits issued and fire watch in place",
    ]),
    S("Working at height", [
      "Edge protection / guardrails on all open edges",
      "Floor openings and shafts covered and marked",
      "Scaffolds tagged and inspected within the last 7 days",
      "Ladders in good condition, secured and used correctly",
      "Harnesses / fall arrest inspected and used where required",
      "Fall protection plan available for the current work",
    ]),
    S("Excavations", [
      "Excavations barricaded and signed",
      "Sides shored, battered or benched as designed",
      "Safe access and egress provided",
      "Spoil and plant kept back from the edge",
      "Services located and marked before digging",
    ]),
    S("Plant, equipment & lifting", [
      "Operators trained and authorised (cards / licences on site)",
      "Pre-use checklists completed for plant",
      "Reverse alarms, lights and beacons working",
      "Lifting equipment certified and lifting plans in place",
      "Exclusion zones around operating plant",
    ]),
    S("Electrical", [
      "Distribution boards closed, locked and labelled",
      "Extension leads and portable tools inspected and tagged",
      "Earth leakage units tested",
      "Cables routed clear of walkways and water",
    ]),
    S("Housekeeping & materials", [
      "Walkways and work areas clear of debris and trip hazards",
      "Materials stacked safely and stable",
      "Waste skips not overfilled; waste separated",
      "Protruding rebar capped",
      "Dust controlled (damping down, extraction)",
    ]),
    S("Hazardous substances & environment", [
      "Safety data sheets available for chemicals on site",
      "Chemicals and fuel stored correctly and bunded",
      "Spill kit available",
      "Stormwater and drains protected from silt and concrete wash",
      "Noise kept within permitted hours / limits",
    ]),
  ]),

  T("daily-walk", "Daily site walk", "Safety", "Daily", [
    S("Start of shift", [
      "Toolbox talk held and attendance recorded",
      "Permits to work in place for today's high-risk tasks",
      "PPE compliance across all trades",
      "Access routes clear and safe",
    ]),
    S("Work areas", [
      "Edges and openings protected",
      "Housekeeping acceptable",
      "Plant operating within exclusion zones",
      "No unsafe acts observed",
      "No unsafe conditions observed",
    ]),
    S("End of shift", [
      "Site secured (gates, plant keys, stores)",
      "Excavations and openings covered or barricaded overnight",
      "Hot work areas checked after work finished",
    ]),
  ]),

  T("scaffold", "Scaffold inspection", "Safety", "Weekly / after bad weather / after alteration", [
    S("Foundation & structure", [
      "Base plates and sole boards on firm, level ground",
      "Standards plumb, ledgers level, couplers tight",
      "Bracing (façade and ledger) complete",
      "Ties / anchors in place at the designed spacing",
      "No unauthorised alterations",
    ]),
    S("Working platforms", [
      "Platforms fully boarded, boards secured and sound",
      "Guardrails, mid-rails and toe boards on all open sides",
      "Safe access ladder / stair, tied and extending above landing",
      "Platform not overloaded with materials",
    ]),
    S("Inspection & control", [
      "Scaffold tag shows status and date of last inspection",
      "Inspection register signed by competent person",
      "Netting / sheeting secure (if fitted)",
      "Public and pedestrians protected below",
    ]),
  ]),

  T("excavation", "Excavation inspection", "Safety", "Daily / before each shift", [
    S("Before entry", [
      "Underground services located, marked and protected",
      "Excavation inspected by competent person this shift",
      "Shoring / battering as per design and in good condition",
      "No water ingress, cracking or sloughing of sides",
    ]),
    S("Edges & access", [
      "Barriers at least 1 m from the edge",
      "Spoil, materials and plant kept back from the edge",
      "Ladders or ramps at suitable intervals",
      "Stop blocks for tipping vehicles",
    ]),
    S("Atmosphere & emergency", [
      "Atmosphere tested where required (deep / confined)",
      "Rescue plan in place",
      "Lighting and warning signs for night time",
    ]),
  ]),

  T("pre-pour", "Pre-pour concrete inspection", "Quality", "Before every pour", [
    S("Formwork", [
      "Formwork to line, level and dimensions on the latest drawing",
      "Formwork clean, release agent applied, joints sealed",
      "Props and backpropping as per temporary works design",
      "Temporary works design checked and signed off",
    ]),
    S("Reinforcement", [
      "Bar sizes, spacing and laps as per reinforcement drawings",
      "Cover spacers / chairs at correct cover",
      "Starter bars and couplers positioned correctly",
      "Steel clean (free of mud, oil, loose rust)",
    ]),
    S("Cast-ins & services", [
      "Sleeves, ducts and conduits in position and secured",
      "Holding-down bolts / cast-in plates set out and checked",
      "Waterstops / construction joints prepared",
    ]),
    S("Pour readiness", [
      "Engineer's inspection and approval obtained",
      "Concrete mix and grade confirmed with supplier",
      "Pour plan, pump and vibrators available",
      "Cube / slump testing arranged",
      "Weather and curing measures planned",
    ]),
  ]),

  T("subcontractor", "Subcontractor compliance audit", "Compliance", "On mobilisation / monthly", [
    S("Documentation", [
      "Health & safety file submitted and approved",
      "Letter of good standing / COID or insurance current",
      "Method statements and risk assessments for current tasks",
      "Required legal appointments in place and signed",
    ]),
    S("People", [
      "Supervisor on site and appointed in writing",
      "Medical certificates current for all workers",
      "Training / competency records for specialist tasks",
      "Toolbox talks held and recorded",
    ]),
    S("Equipment", [
      "Tools and equipment inspected and register kept",
      "PPE issue register maintained",
      "Plant inspection records available",
    ]),
  ]),

  T("snag", "Snag / pre-handover quality inspection", "Quality", "Before handover", [
    S("Finishes", [
      "Walls: plaster / paint finish free of defects",
      "Ceilings: level, joints and paint finish acceptable",
      "Floors: finish, levels and skirtings complete",
      "Tiling: grout, alignment, no cracked or hollow tiles",
    ]),
    S("Doors & windows", [
      "Doors hung correctly, close and latch, ironmongery fitted",
      "Windows open, close and lock; glazing undamaged",
      "Sealants complete and neat",
    ]),
    S("Services", [
      "Light fittings and switches working, cover plates fitted",
      "Socket outlets tested and labelled",
      "Sanitaryware secure, no leaks, taps working",
      "HVAC / extract fans operating",
    ]),
    S("Completion", [
      "Area clean and free of builder's rubble",
      "Protection removed",
      "Operation & maintenance info and certificates received",
    ]),
  ]),
];

module.exports = { BUILT_IN_TEMPLATES };
