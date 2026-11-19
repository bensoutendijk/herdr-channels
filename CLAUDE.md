# Working on herdr-channels

## Screenshots with a contribution

Every contribution (a PR, or a commit to a branch meant for one) is checked for whether it should come
with screenshots, before the PR is opened. The check is made by a right-sized model, not settled from
memory by the agent doing the work:

1. Hand the question to a subagent on a small model: the Agent tool with `model: "haiku"`, or
   `"sonnet"` when the diff is large or what it changes on screen isn't plain from the code. Give it:
   - the diff (`git diff origin/main...HEAD`, or its stat plus the UI-facing files whole when it's big),
   - the screenshots the README shows now (`preview.png` and `docs/*.png`, each with its alt text),
   - this question: *Does this change alter anything a person sees (the herdr mod's sidebar, header
     bar, tasks panel, dialogs or layout; the task cards in a channel's chat; text drawn in any of
     them), or make one of the existing screenshots wrong? Answer `new` (which view, and why),
     `update` (which file, and why) or `none`, with one line of reason.*
2. Act on the answer:
   - `new` or `update`: take the screenshots in a sandbox, as the README's "Trying a change in a
     sandbox" says (own `HOME`, `HERDR_APP_HOME` and launchd label; never your own Herdr or Claude
     setup). Use demo channels and tasks, and set `CHANNELS_MACHINE=studio` in the sandbox's
     `channels` command before any chat starts, so no real host name shows. `herdr-app shot` gives
     the window; crop to the pane that matters (`sips -c <h> <w> --cropOffset <y> <x>`). Put them in
     `docs/` (or replace the file named), show them in the README with alt text that says what is on
     screen, and list them in the PR description. Tear the sandbox down after.
   - `none`: say so in the PR description, with the reason given.
3. If you disagree with the answer (it missed a visible change, or wants a picture of a refactor),
   say so in the PR description and do what the change calls for.

Screenshots and README text name no person, home folder or host of their own; `test/install.test.mjs`
checks the text.
