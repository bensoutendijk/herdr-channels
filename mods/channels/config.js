// The channels mod's settings. install.mjs writes this file in the installed copy; these are the
// defaults for a copy made by hand.
export default {
  mod: "channels", // this mod's folder under mods/
  layout: "channels", // the layout that shows it, layouts/<layout>.json
  command: "channels", // the channels command: an absolute path, or a name found on `path`
  path: "", // folders put first on PATH for the programs the mod runs (channels, node, claude, hc, python3)
  projects: "", // where a fresh session and a channel's chat start; empty is ~/projects
  by: "user", // who a task resolved in the panel is recorded as resolved by
};
