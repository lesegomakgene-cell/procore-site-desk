"use strict";
// The topic cards shown in the app, and a simple classifier so the admin
// dashboard can show what people ask about (without keeping their questions).

const TOPICS = [
  { label: "Daily Log", hint: "Manpower, weather, deliveries", question: "How do I fill in the daily log on the Procore mobile app?" },
  { label: "RFIs", hint: "Raise and answer queries", question: "How do I create and submit an RFI in Procore?" },
  { label: "Submittals", hint: "Review and respond", question: "How do I respond to a submittal assigned to me?" },
  { label: "Drawings", hint: "Latest revisions and markups", question: "How do I find the latest revision of a drawing and mark it up?" },
  { label: "Inspections", hint: "Checklists on site", question: "How do I complete an inspection in Procore?" },
  { label: "Observations", hint: "Raise a safety observation", question: "How do I raise a safety observation?" },
  { label: "Incidents", hint: "Report what happened", question: "How do I report an incident in Procore?" },
  { label: "Punch List", hint: "Add and assign items", question: "How do I add and assign a punch list item?" },
  { label: "Photos", hint: "Upload and organise", question: "How do I upload site photos and link them to a location?" },
  { label: "Schedule", hint: "Programme and tasks", question: "How do I view the project schedule and my tasks?" },
];

// First match wins, so the more specific topics come first.
const RULES = [
  ["Incidents", /incident|accident|near[- ]miss|injur/i],
  ["Observations", /observation/i],
  ["Inspections", /inspection|checklist|\bitp\b/i],
  ["Daily Log", /daily ?log|manpower|delivery log|weather/i],
  ["RFIs", /\brfis?\b|request for information/i],
  ["Submittals", /submittal/i],
  ["Drawings", /drawing|revision|mark-?up|\bsheets?\b|plan set/i],
  ["Punch List", /punch/i],
  ["Photos", /photo|picture|image/i],
  ["Timesheets", /timesheet|time ?card|hours worked/i],
  ["Meetings", /meeting|minutes/i],
  ["Forms", /\bforms?\b|template/i],
  ["Safety", /safety|toolbox|hazard|\bppe\b/i],
  ["Schedule", /schedule|programme|gantt|\btasks?\b/i],
  ["Documents", /document|folder|upload|\bfiles?\b/i],
  ["Mobile app", /\bapp\b|mobile|offline|sync|android|iphone/i],
  ["Access & permissions", /permission|access|invite|\broles?\b|sign ?in|log ?in|password/i],
];

function classify(text) {
  const s = String(text || "");
  for (const [label, re] of RULES) if (re.test(s)) return label;
  return "Other";
}

const ROLES = [
  "Site agent / manager",
  "Foreman / supervisor",
  "Site engineer",
  "Safety officer",
  "Quality / inspector",
  "Subcontractor",
  "Office / admin",
  "Other",
];

module.exports = { TOPICS, classify, ROLES };
