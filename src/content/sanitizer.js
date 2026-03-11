// eslint-disable-next-line no-unused-vars
function sanitizeText(input = "") {
  return input
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s.,!?-]/gu, "")
    .trim();
}
