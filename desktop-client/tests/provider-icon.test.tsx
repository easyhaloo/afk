import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "../src/components/ProviderIcon";

describe("ProviderIcon", () => {
  it.each(["github", "gitlab"] as const)("renders the saved %s SVG asset with an accessible label", provider => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(createElement(ProviderIcon, { provider })); });

    const image = renderer.root.findByType("img");
    expect(image.props.alt).toBe(provider === "github" ? "GitHub" : "GitLab");
    expect(image.props.src).toContain(`/provider-icons/${provider}.svg`);
  });
});
