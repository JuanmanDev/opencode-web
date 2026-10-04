export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot writes conventional subjects but long release-note bodies
  ignores: [(message) => /^Signed-off-by: dependabot\[bot\]/m.test(message)]
}
