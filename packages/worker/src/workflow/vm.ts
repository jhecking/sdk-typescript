import assert from 'assert';
import { AsyncLocalStorage } from 'async_hooks';
import vm from 'vm';
import { gte } from 'semver';
import { IllegalStateError } from '@temporalio/common';
import { Workflow, WorkflowCreateOptions, WorkflowCreator } from './interface';
import { WorkflowBundleWithSourceMapAndFilename } from './workflow-worker-thread/input';
import {
  BaseVMWorkflow,
  globalHandlers,
  injectConsole,
  setUnhandledRejectionHandler,
  WorkflowModule,
} from './vm-shared';

/**
 * A WorkflowCreator that creates VMWorkflows in the current isolate
 */
export class VMWorkflowCreator implements WorkflowCreator {
  private static unhandledRejectionHandlerHasBeenSet = false;
  static workflowByRunId = new Map<string, VMWorkflow>();
  readonly hasSeparateMicrotaskQueue: boolean;

  script?: vm.Script;

  constructor(
    script: vm.Script,
    public readonly workflowBundle: WorkflowBundleWithSourceMapAndFilename,
    public readonly isolateExecutionTimeoutMs: number
  ) {
    if (!VMWorkflowCreator.unhandledRejectionHandlerHasBeenSet) {
      setUnhandledRejectionHandler((runId) => VMWorkflowCreator.workflowByRunId.get(runId));
      VMWorkflowCreator.unhandledRejectionHandlerHasBeenSet = true;
    }

    // https://nodejs.org/api/vm.html#vmcreatecontextcontextobject-options
    // microtaskMode=afterEvaluate was added in 14.6.0
    this.hasSeparateMicrotaskQueue = gte(process.versions.node, '14.6.0');

    this.script = script;
  }

  /**
   * Create a workflow with given options
   */
  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    const context = await this.getContext();
    this.injectConsole(context);
    const { isolateExecutionTimeoutMs } = this;
    const workflowModule: WorkflowModule = new Proxy(
      {},
      {
        get(_: any, fn: string) {
          return (...args: any[]) => {
            context.__TEMPORAL__.args = args;
            return vm.runInContext(`__TEMPORAL__.api.${fn}(...__TEMPORAL__.args)`, context, {
              timeout: isolateExecutionTimeoutMs,
              displayErrors: true,
            });
          };
        },
      }
    ) as any;

    workflowModule.initRuntime({ ...options, sourceMap: this.workflowBundle.sourceMap });
    const activator = context.__TEMPORAL_ACTIVATOR__ as any;

    const newVM = new VMWorkflow(
      options.info,
      context,
      activator,
      workflowModule,
      isolateExecutionTimeoutMs,
      this.hasSeparateMicrotaskQueue
    );
    VMWorkflowCreator.workflowByRunId.set(options.info.runId, newVM);
    return newVM;
  }

  protected async getContext(): Promise<vm.Context> {
    if (this.script === undefined) {
      throw new IllegalStateError('Isolate context provider was destroyed');
    }
    let context;
    const globals = { AsyncLocalStorage, assert, __webpack_module_cache__: {} };
    if (this.hasSeparateMicrotaskQueue) {
      context = vm.createContext(globals, { microtaskMode: 'afterEvaluate' });
    } else {
      context = vm.createContext(globals);
    }
    this.script.runInContext(context);
    return context;
  }

  /**
   * Inject console.log and friends into a vm context.
   *
   * Overridable for test purposes.
   */
  protected injectConsole(context: vm.Context): void {
    injectConsole(context);
  }

  /**
   * Create a new instance, pre-compile scripts from given code.
   *
   * This method is generic to support subclassing.
   */
  public static async create<T extends typeof VMWorkflowCreator>(
    this: T,
    workflowBundle: WorkflowBundleWithSourceMapAndFilename,
    isolateExecutionTimeoutMs: number
  ): Promise<InstanceType<T>> {
    globalHandlers.install();
    await globalHandlers.addWorkflowBundle(workflowBundle);
    const script = new vm.Script(workflowBundle.code, { filename: workflowBundle.filename });
    return new this(script, workflowBundle, isolateExecutionTimeoutMs) as InstanceType<T>;
  }

  /**
   * Cleanup the pre-compiled script
   */
  public async destroy(): Promise<void> {
    globalHandlers.removeWorkflowBundle(this.workflowBundle);
    delete this.script;
  }
}

/**
 * A Workflow implementation using Node.js' built-in `vm` module
 */
export class VMWorkflow extends BaseVMWorkflow {
  public async dispose(): Promise<void> {
    this.workflowModule.dispose();
    VMWorkflowCreator.workflowByRunId.delete(this.info.runId);
    delete this.context;
  }
}
