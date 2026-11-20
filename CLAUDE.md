# Working on herdr-channels

## PR titles

PRs are squash-merged under their title, and semantic-release reads that title to cut a release on
every merge to main (`.github/workflows/release.yml`). So every PR title is a Conventional Commit, and
the `pr-title` check refuses one that isn't:

- `feat: …` for something new a person can use (a minor release), `fix: …` for a bug fixed (a patch),
  `feat!: …` or `fix!: …` when it breaks how an existing install or command works (a major).
- `docs: …`, `chore: …`, `refactor: …`, `test: …`, `ci: …`, `build: …`, `perf: …` for the rest
  (`perf` cuts a patch; the others cut no release).
- After the prefix, the title is the repo's usual plain sentence, capitalized, saying what changes
  for the person using it: `feat: Releases on GitHub, and one-click updates from the sidebar`,
  `fix: A chat mid-turn restarts after its turn, not during it`.

A PR's own commits can be titled freely: only the squash commit (the PR title) reaches main. Merge
with "Squash and merge" so it does.

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
