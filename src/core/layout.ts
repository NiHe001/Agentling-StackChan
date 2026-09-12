import type { LayoutConfig, UiConfig, WidgetConfig } from "./types";

export function resolveLayout(ui: UiConfig, name: string): WidgetConfig[] {
  const visiting = new Set<string>();
  const visit = (layoutName: string): WidgetConfig[] => {
    if (visiting.has(layoutName)) throw new Error("layout inheritance cycle");
    const layout: LayoutConfig | undefined = ui.layouts[layoutName];
    if (!layout) throw new Error(`unknown layout '${layoutName}'`);
    visiting.add(layoutName);
    const inherited = layout.extends ? visit(layout.extends) : [];
    const byId = new Map(inherited.map((widget) => [widget.id, structuredClone(widget)]));
    for (const widget of layout.widgets ?? []) byId.set(widget.id, structuredClone(widget));
    for (const [id, override] of Object.entries(layout.overrides ?? {})) {
      const previous = byId.get(id);
      if (!previous) throw new Error(`override references unknown widget '${id}'`);
      byId.set(id, {
        ...previous,
        ...override,
        rect: override.rect ? { ...previous.rect, ...override.rect } : previous.rect,
        props: { ...previous.props, ...override.props },
        style: { ...previous.style, ...override.style },
      });
    }
    visiting.delete(layoutName);
    return [...byId.values()].sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0));
  };
  return visit(name);
}
