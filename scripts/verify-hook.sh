#!/usr/bin/env bash
# Hook PreToolUse (matcher Bash). Lê o JSON do hook no stdin, extrai tool_input.command e,
# se o comando executa `git push` ou `gh pr create` (também com opções globais, em cadeias
# &&, ||, ;, | e dentro de bash -c), roda o gate. O settings.json executa a versão deste
# arquivo que está em origin/main (senão main, senão o arquivo local).
set -u

payload="$(cat)"

hit="$(PAYLOAD="$payload" node -e '
const input = JSON.parse(process.env.PAYLOAD || "{}");
const cmd = (input.tool_input && input.tool_input.command) || "";

// Tokeniza como o shell: respeita aspas e separa comandos em && || ; | & e quebras de linha.
function segments(str) {
  const out = [[]];
  let cur = "", quote = null, has = false;
  const push = () => { if (has) out[out.length - 1].push(cur); cur = ""; has = false; };
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === "\"" && i + 1 < str.length) cur += str[++i];
      else cur += c;
      continue;
    }
    if (c === "\"" || c === "\x27") { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < str.length) { cur += str[++i]; has = true; continue; }
    if (/\s/.test(c) && c !== "\n") { push(); continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      push();
      if (out[out.length - 1].length) out.push([]);
      continue;
    }
    cur += c; has = true;
  }
  push();
  return out.filter((s) => s.length);
}

const GIT_VAL = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const GH_VAL = new Set(["-R", "--repo", "--hostname"]);
const WRAPPERS = new Set(["sudo", "command", "env", "exec", "time", "nohup", "xargs"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

function check(tokens, depth) {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || WRAPPERS.has(tokens[i]) || tokens[i] === "!")) i++;
  const bin = (tokens[i] || "").split("/").pop();
  const rest = tokens.slice(i + 1);
  if (SHELLS.has(bin) && depth < 4) {
    const k = rest.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t));
    if (k >= 0 && rest[k + 1] !== undefined) return scan(rest[k + 1], depth + 1);
    return false;
  }
  if (bin === "git") {
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j];
      if (GIT_VAL.has(t)) { j++; continue; }
      if (t.startsWith("-")) continue;
      return t === "push";
    }
    return false;
  }
  if (bin === "gh") {
    const words = [];
    for (let j = 0; j < rest.length; j++) {
      const t = rest[j];
      if (GH_VAL.has(t)) { j++; continue; }
      if (t.startsWith("-")) continue;
      words.push(t);
      if (words.length === 2) break;
    }
    return words[0] === "pr" && words[1] === "create";
  }
  return false;
}

function scan(str, depth) {
  return segments(str).some((s) => check(s, depth));
}
process.stdout.write(scan(cmd, 0) ? "yes" : "no");
' 2>/dev/null || echo yes)"

[ "$hit" = "yes" ] || exit 0

ref=""
for r in origin/main main; do
  if git cat-file -e "$r:scripts/verify-gate.sh" 2>/dev/null; then ref="$r"; break; fi
done
if [ -n "$ref" ]; then
  git show "$ref:scripts/verify-gate.sh" | bash
else
  bash scripts/verify-gate.sh
fi
