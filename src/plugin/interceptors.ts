/**
 * InterceptorPipeline — middleware-style pre/post hooks for data flow.
 *
 * before* hooks can modify data or return null to cancel the operation.
 * after* hooks can modify results (cannot cancel).
 */

// Late-binding reference to PluginManager (set by manager.ts to avoid circular import)
interface ManagerRef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllPlugins: () => { status: string; hooks: Record<string, any>; manifest: { id: string } }[];
  makeContextFor: (pluginId: string) => unknown;
}

let _managerRef: ManagerRef | null = null;

/** Called once by manager.ts constructor to inject reference */
export function setManagerRef(ref: ManagerRef) {
  _managerRef = ref;
}

export class InterceptorPipeline {
  /**
   * Run "before" interceptors. Returns modified data or null if cancelled.
   */
  async runBefore<T>(hookName: string, callerPluginId: string, data: T): Promise<T | null> {
    if (!_managerRef) return data;
    const manager = _managerRef;

    const plugins = manager.getAllPlugins().filter(
      (p) => p.status === "enabled" && p.manifest.id !== callerPluginId,
    );

    for (const plugin of plugins) {
      const hook = (plugin.hooks as Record<string, unknown>)[hookName];
      if (typeof hook !== "function") continue;

      const ctx = manager.makeContextFor(plugin.manifest.id);
      try {
        const result = await (hook as Function)(ctx, data);
        if (result === null) {
          console.log(
            `[Interceptor] ${hookName} cancelled by plugin ${plugin.manifest.id}`,
          );
          return null;
        }
        if (result !== undefined) {
          data = result as T;
        }
      } catch (err) {
        console.warn(
          `[Interceptor] ${hookName} error in ${plugin.manifest.id}:`,
          err,
        );
      }
    }
    return data;
  }

  /**
   * Run "after" interceptors. Always returns data (cannot cancel).
   */
  async runAfter<T>(hookName: string, callerPluginId: string, data: T): Promise<T> {
    if (!_managerRef) return data;
    const manager = _managerRef;

    const plugins = manager.getAllPlugins().filter(
      (p) => p.status === "enabled" && p.manifest.id !== callerPluginId,
    );

    for (const plugin of plugins) {
      const hook = (plugin.hooks as Record<string, unknown>)[hookName];
      if (typeof hook !== "function") continue;

      const ctx = manager.makeContextFor(plugin.manifest.id);
      try {
        const result = await (hook as Function)(ctx, data);
        if (result !== undefined && result !== null) {
          data = { ...data, ...result } as T;
        }
      } catch (err) {
        console.warn(
          `[Interceptor] ${hookName} error in ${plugin.manifest.id}:`,
          err,
        );
      }
    }
    return data;
  }
}

/** Singleton pipeline */
export const interceptorPipeline = new InterceptorPipeline();
