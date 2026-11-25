// Read the text a person has already typed into an agent's composer.
//
// tmux can only see rendered cells, so this is deliberately conservative: a
// single-line draft is safe to save and put back, while anything that looks
// wrapped or multi-line is reported instead of being rewritten, because a
// wrong reconstruction would corrupt the person's own words.
const PROMPT = /^\s*(?:>|❯|›)\s?(.*)$/
const RULE = /^\s*[─━═╌╭╰│]{3,}/
const FOOTER = /^\s*(\? for shortcuts|ctrl\+|esc to|shift\+tab)/i

export interface PaneDraft {
  text: string
  multiline: boolean
}

export function extractDraft(paneText: string): PaneDraft {
  const lines = String(paneText ?? '').replace(/\r/g, '').split('\n')
  let index = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (PROMPT.test(lines[i])) { index = i; break }
  }
  if (index < 0) return { text: '', multiline: false }
  const first = (lines[index].match(PROMPT)?.[1] ?? '').trimEnd()
  const tail: string[] = []
  for (let i = index + 1; i < lines.length; i += 1) {
    const raw = lines[i]
    if (RULE.test(raw) || FOOTER.test(raw)) break
    if (raw.trim() === '') { if (tail.length === 0) continue; break }
    tail.push(raw.trimEnd())
  }
  if (tail.length === 0) return { text: first, multiline: false }
  return { text: [first, ...tail].filter(Boolean).join('\n'), multiline: true }
}
