/**
 * Ambient type declarations for @aliou/pi-utils-ui.
 * Available at runtime via pi-processes' node_modules (shared Node.js process).
 * Do NOT add @aliou/pi-utils-ui to package.json.
 */
declare module "@aliou/pi-utils-ui" {
  import type { Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
  import type { Component } from "@mariozechner/pi-tui";

  export interface ToolCallHeaderOptionArg {
    label: string;
    value: string;
    tone?: "muted" | "accent" | "success" | "warning" | "error" | "dim";
  }

  export interface ToolCallHeaderLongArg {
    label?: string;
    value: string;
  }

  export interface ToolCallHeaderConfig {
    toolName: string;
    action?: string;
    mainArg?: string;
    optionArgs?: ToolCallHeaderOptionArg[];
    longArgs?: ToolCallHeaderLongArg[];
    showColon?: boolean;
  }

  export class ToolCallHeader implements Component {
    constructor(config: ToolCallHeaderConfig, theme: Theme);
    handleInput(data: string): boolean;
    invalidate(): void;
    update(config: ToolCallHeaderConfig): void;
    render(width: number): string[];
  }

  export type ToolBodyField =
    | { label: string; value: string; showCollapsed?: boolean }
    | (Component & { showCollapsed?: boolean });

  export interface ToolBodyConfig {
    fields: ToolBodyField[];
    footer?: Component;
    includeSpacerBeforeFooter?: boolean;
  }

  export class ToolBody implements Component {
    constructor(config: ToolBodyConfig, options: ToolRenderResultOptions, theme: Theme);
    handleInput(data: string): boolean;
    invalidate(): void;
    update(config: ToolBodyConfig, options: ToolRenderResultOptions): void;
    render(width: number): string[];
  }

  export interface ToolFooterItem {
    label?: string;
    value: string;
    tone?: "muted" | "accent" | "success" | "warning" | "error";
  }

  export interface ToolFooterConfig {
    items: ToolFooterItem[];
    separator?: " - " | " | ";
    truncate?: boolean;
  }

  export class ToolFooter implements Component {
    constructor(theme: Theme, config: ToolFooterConfig);
    handleInput(data: string): boolean;
    invalidate(): void;
    update(config: ToolFooterConfig): void;
    render(width: number): string[];
  }
}
