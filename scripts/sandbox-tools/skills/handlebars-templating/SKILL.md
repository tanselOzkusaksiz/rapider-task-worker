---
name: handlebars-templating
description: Authoring, sample-data compile verification, and Workspace persistence for Handlebars (.hbs) email, document, and notification templates.
---

# Handlebars Templating Playbook

1. **Check Existing Templates**:
   - Inspect `workspace-context/templates/message-templates.json` and `template-definitions.json` to match Workspace naming conventions and variable structures.
2. **Compile & Verify Before Delivering**:
   - Save your `.hbs` template in `../output/deliverables/<slug>.hbs` and construct a realistic `../output/sample-data.json` grounded in actual Workspace model fields.
   - Always run:
     ```bash
     node ../tools/rapider-task-cli.js verify-handlebars --template=../output/deliverables/<slug>.hbs --data=../output/sample-data.json --out=../output/deliverables/<slug>-preview.html
     ```
   - Fix any uninterpolated `{{...}}` tokens or `[object Object]` warnings before finishing.
3. **Save to Workspace When Requested**:
   - If the user asked to create or update a Workspace `MessageTemplate`, persist it via:
     ```bash
     node ../tools/rapider-task-cli.js save-message-template --key=<slug> --subject="<Subject>" --file=../output/deliverables/<slug>.hbs
     ```

