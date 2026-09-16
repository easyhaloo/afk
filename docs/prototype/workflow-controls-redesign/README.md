# Workflow Buttons & Status Labels Prototype

This prototype explores a unified control and status system for both the workflow library and canvas editor while preserving the current AFK desktop visual language.

## Design direction

- Preserve the existing white workspace, orange active navigation, muted blue/green node colors, thin borders, and low-elevation shadows.
- Keep icon-only buttons for universally understood actions such as create, add step, zoom, and card navigation.
- Keep text buttons where the result needs explicit wording, especially save and inspector actions.
- Use compact outlined status pills that match the current run-status palette instead of introducing a new visual system.
- Surface readable execution state on workflow cards and canvas nodes rather than relying on unlabeled colored dots.
- Keep status information quiet and inline; active work is visible without competing with the task content.
- Use one compact dark primary action per context, with remaining actions expressed as restrained icon controls.

Open `index.html` to review the workflow library and canvas states together.
