import { describe, expect, it } from "vitest";
import { parsePrMetadata } from "../../src/github/pr-metadata.js";

const title = "ANY-451 - Add payment validation";
const url = "https://linear.app/paveldik/issue/ANY-451";
const body = `## Linear issue\n${url}\n\n## Changes\nValidation`;

describe("PR metadata", () => {
  it("extracts only the matching key from a full URL", () => {
    expect(parsePrMetadata(title, body)).toBe("ANY-451");
    expect(parsePrMetadata(title, `## Linear issue\n[Ticket](${url}/payment-validation)`)).toBe(
      "ANY-451",
    );
  });
  it("ignores fenced sections, including longer and tilde fences", () => {
    expect(
      parsePrMetadata(
        title,
        `\`\`\`\`md\n## Linear issue\n${url}\n\`\`\`\n\`\`\`\`\n~~~\n## Linear issue\n${url}\n~~~\n${body}`,
      ),
    ).toBe("ANY-451");
  });
  it.each([
    "ANY-0 - Fix bug",
    "ANY-0451 - Fix bug",
    "any-451 - Fix bug",
    "ANY-451: Fix bug",
    "ANY-451 - X",
    "ANY-451 - Fix bug ",
    "ANY-451 - Fix bug\n",
  ])("rejects invalid title %j", (value) => {
    expect(parsePrMetadata(value, body)).toBeNull();
  });
  it.each([
    "",
    `## Linear issue\nANY-451`,
    `## Linear issue\n${url.replace("451", "452")}`,
    `## Linear issue\n${url.replace("paveldik", "other")}`,
    `${body}\n## Linear issue\n${url}`,
    `## Linear issue\n${url}\n${url}`,
    `## Linear issue\n\n## Other\n${url}`,
    `\`\`\`\n${body}\n\`\`\``,
    `<!--\n${body}\n-->`,
    `    ## Linear issue\n    ${url}`,
    `## Linear issue\n${url}0`,
    `## Linear issue\n${url}.evil`,
    `## Linear issue\nhttps://linear.app.evil/paveldik/issue/ANY-451`,
    `## Linear issue\n\`${url}\``,
    `## Linear issue\n${url}\nhttps://linear.app/paveldik/issue/ANY-452`,
  ])("rejects missing, hidden, mismatched or ambiguous metadata %j", (value) => {
    expect(parsePrMetadata(title, value)).toBeNull();
  });
});

it.each(["pre", "script", "style", "textarea", "div", "details"])(
  "ignores Linear sections inside raw HTML %s blocks",
  (tag) => {
    expect(parsePrMetadata(title, `<${tag}>\n${body}\n</${tag}>`)).toBeNull();
  },
);

it.each([
  `## Linear issue\n\`\n${url}\n\``,
  `## Linear issue\n\`\`first line\n\` nested tick ${url}\nlast line\`\``,
])("ignores issue URLs inside multiline code spans %j", (value) => {
  expect(parsePrMetadata(title, value)).toBeNull();
});

it.each([
  `## Linear issue\n[Ticket](${url}(evil))`,
  `## Linear issue\n[Ticket](${url}/payment-validation(evil))`,
  `## Linear issue\n[Ticket](${url}((nested)))`,
])("rejects the complete invalid link destination %j", (value) => {
  expect(parsePrMetadata(title, value)).toBeNull();
});

it.each([
  `## Linear issue\n${url}`,
  `## Linear issue\n<${url}>`,
  `## Linear issue\n[Ticket](${url})`,
  `## Linear issue\n[Ticket](${url}/payment-validation)`,
  `## Linear issue\n\`\`unclosed\n${url}\n\``,
])("retains canonical and slug URL forms outside code spans %j", (value) => {
  expect(parsePrMetadata(title, value)).toBe("ANY-451");
});

it("keeps unmatched closing parenthesis punctuation outside a bare URL", () => {
  expect(parsePrMetadata(title, `## Linear issue\n(${url})`)).toBe("ANY-451");
  expect(parsePrMetadata(title, `## Linear issue\n${url}(evil)`)).toBeNull();
});

it("retains unmatched parentheses inside explicit angle destinations", () => {
  expect(parsePrMetadata(title, `## Linear issue\n<${url})evil>`)).toBeNull();
});
