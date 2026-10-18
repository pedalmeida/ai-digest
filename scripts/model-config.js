export function digestModel(environment = process.env) {
  return environment.ANTHROPIC_MODEL || "claude-opus-5";
}
