/**
 * Server-side stub. All of the xats UI lives in ./tui.tsx; this file exists so
 * the plugin directory is a well-formed package that OpenCode can load.
 *
 * Session registration, inbox delivery, and the tools are owned by
 * xats-register.ts — keeping them apart means a TUI error can never take
 * messaging down.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "xats.ui.stub",
  setup() {},
})
