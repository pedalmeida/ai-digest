export function digestModel(environment = process.env) {
  return environment.ANTHROPIC_MODEL || "claude-haiku-4-5";
}
