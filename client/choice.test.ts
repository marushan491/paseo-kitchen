import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Choice, filterChoices } from "./choice.js";

test("a large advertised catalog stays bounded while a model ID remains searchable", () => {
  const options = Array.from({ length: 20 }, (_, index) => ({
    id: `provider/model-${index}`,
    title: `Model ${index}`,
    disabled: index === 19,
  }));
  expect(filterChoices(options, "")).toMatchObject({ count: 20, visible: options.slice(0, 8) });
  expect(filterChoices(options, " MODEL-19 ")).toEqual({ count: 1, visible: [options[19]] });
  expect(filterChoices(options, "not-advertised")).toEqual({ count: 0, visible: [] });
  expect(options).toHaveLength(20);
});

function ignoreChoice() {}

test("identical visible inheritance choices expose their distinct role to assistive technology", () => {
  const host = {
    theme: { colors: {} },
    layout: { compact: false, platform: "web" },
  } as unknown as PluginSurfaceProps;
  function render(label: string) {
    return renderToStaticMarkup(
      createElement(Choice, {
        ...host,
        label,
        value: "",
        options: [],
        allowEmpty: true,
        emptyTitle: "Inherit source / project",
        onChange: ignoreChoice,
      }),
    );
  }
  expect(render("Developer")).toContain('aria-label="Developer: Inherit source / project"');
  expect(render("Reviewer")).toContain('aria-label="Reviewer: Inherit source / project"');
});
