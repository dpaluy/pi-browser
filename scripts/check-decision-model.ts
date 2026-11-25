import assert from "node:assert/strict";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { decisionModel } from "../src/decision.ts";
import { locate, type Query } from "../src/locate.ts";
import { settingsStore } from "../src/settings.ts";
import { formatFind, resolveTarget } from "../src/targets.ts";

// Checks the decision model configured in <agentDir>/browser/settings.json (or TYPESAFE_API_KEY) on a sample page:
// three element targets and one find query must resolve correctly. Makes real requests to the configured provider.
const decision = decisionModel(await settingsStore(join(getAgentDir(), "browser")).load(), process.env);
assert(decision, "No decision model is configured. Add \"decision\" to settings.json or set TYPESAFE_API_KEY.");
console.log(`Checking ${decision.label}`);

// Hand-written accessibility snapshot excerpt from test/e2e/fixtures/controls.html.
const lines = `Tab 42: Pi controls <http://controls.test/controls.html>
RootWebArea "Pi controls"
  main
    heading "Create your account"
    [11] textbox "Email address" = "old@example.com"
    [12] combobox "Country" = "Choose"
    [13] listbox "Toppings"
    [14] checkbox "Subscribe to newsletter"
    [15] switch "Dark mode"
    [16] button "Attach documents"
    [17] button "Create account"
    paragraph
      nothing yet
    [18] button "Show message later"
    list
      listitem
        Blue mug
        [19] button "Delete"
      listitem
        Red kettle
        [20] button "Delete"
    paragraph
      Shipping is free on orders over $50.`.split("\n");

const queries: Query[] = ["Email address textbox", "Create account button", "Dark mode switch"]
  .map(text => ({ text, kind: "element" }));
queries.push({ text: "At what order amount is shipping free?", kind: "content" });
const matches = await locate(lines, queries, decision, AbortSignal.timeout(60_000));
const expectedRefs = [11, 17, 15];
let correct = true;
for (const [i, query] of queries.entries()) {
  const match = matches[i];
  console.log(JSON.stringify({ query: query.text, ...match }));
  if (query.kind === "content") {
    console.log(formatFind(lines, query.text, match));
    correct &&= match.exists >= 0.7 && lines[match.hits[0]?.line]?.includes("Shipping is free on orders over $50.");
    continue;
  }
  try {
    const target = resolveTarget(lines, query.text, match);
    console.log(target.note);
    correct &&= target.ref === expectedRefs[i];
  } catch (error) {
    console.log(String(error));
    correct = false;
  }
}
assert(correct, `${decision.label} did not correctly resolve every target and find query (see probabilities above).`);
console.log(`${decision.label} resolved every target and find query.`);
