import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const bash = createBashToolDefinition(process.cwd());
const thenRunSchema = Type.Optional(Type.Object(bash.parameters.properties, {
	description: "Run this bash command after the file mutation succeeds, in the session working directory. Execution is sequential, not parallel. Command failure leaves the mutation applied.",
}));

function fuse(base: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
	return {
		...base,
		parameters: Type.Object({ ...base.parameters.properties, then_run: thenRunSchema }),
		description: `${base.description} Optionally include then_run {command, timeout} to run a known follow-up command after a successful mutation and receive both results in one call. If mutation fails, the command is skipped; command failure does not revert the file.`,
		async execute(id, args: any, signal, onUpdate, ctx) {
			const { then_run, ...mutationArgs } = args;
			let mutation;
			try {
				mutation = await base.execute(id, mutationArgs, signal, onUpdate, ctx);
			} catch (error) {
				if (!then_run) throw error;
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n[then_run:skipped] File mutation failed; command was not run.`);
			}
			if (!then_run || mutation.isError) return mutation;

			const combine = (result: AgentToolResult<any>) => ({
				...mutation,
				content: [
					...mutation.content,
					{ type: "text" as const, text: `[then_run:${result.isError ? "failed" : "succeeded"}] $ ${then_run.command}` },
					...result.content,
				],
				details: {
					...mutation.details,
					thenRun: { command: then_run.command, result, mutationContent: mutation.content },
				},
				isError: result.isError ?? false,
			});
			// Use the active bash tool, including its validation, hooks, shell settings,
			// cancellation and output limits. Pi accounts for nested usage itself.
			const outcome = await ctx.executeTool("bash", then_run, {
				signal,
				onUpdate: onUpdate ? (partial) => onUpdate({
					...combine(partial),
					content: [
						...mutation.content,
						{ type: "text", text: `[then_run:running] $ ${then_run.command}` },
						...partial.content,
					],
				}) : undefined,
			});
			return combine({ ...outcome.result, isError: outcome.isError });
		},
		renderCall(args: any, theme, context) {
			if (!args.then_run) return base.renderCall!(args, theme, context);
			const container = new Container();
			container.addChild(base.renderCall!(args, theme, { ...context, lastComponent: undefined }));
			container.addChild(bash.renderCall!(args.then_run, theme, { ...context, args: args.then_run, lastComponent: undefined }));
			return container;
		},
		renderResult(result, options, theme, context) {
			const followup = result.details?.thenRun;
			if (!followup) return base.renderResult!(result, options, theme, {
				...context, lastComponent: (context.args as any)?.then_run ? undefined : context.lastComponent,
			});
			const container = new Container();
			container.addChild(base.renderResult!({
				...result, content: followup.mutationContent,
			}, options, theme, { ...context, isError: false, lastComponent: undefined }));
			container.addChild(bash.renderResult!(followup.result, options, theme, {
				...context, args: { command: followup.command }, isError: followup.result.isError ?? false, lastComponent: undefined,
			}));
			return container;
		},
	};
}

export default function actionFusion(pi: ExtensionAPI) {
	pi.registerTool(fuse(createWriteToolDefinition(process.cwd())));
	pi.registerTool(fuse(createEditToolDefinition(process.cwd())));
}
