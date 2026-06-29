<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import { copyToClipboard } from '$lib/utils/copy';
	import Copy from 'carbon-icons-svelte/lib/Copy.svelte';
	import Checkmark from 'carbon-icons-svelte/lib/Checkmark.svelte';

	let { code, class: className }: { code: string; class?: string } = $props();

	let copied = $state(false);

	async function handleCopy(value: string) {
		if (!value) return;
		try {
			await copyToClipboard(value);
			copied = true;
		} catch {
			console.error('Failed to copy code snippet');
		}
	}

	// Reset the copied state after 2 seconds
	$effect(() => {
		if (!copied) return;
		const t = setTimeout(() => {
			copied = false;
		}, 2000);
		return () => {
			clearTimeout(t);
		};
	});

	// Reset when code changes
	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		code;
		copied = false;
	});
</script>

<button
	type="button"
	class={cn(
		'group transition-scale inset-shadow relative flex size-7 items-center justify-center rounded-sm bg-background-inset text-foreground duration-150 ease-out active:scale-[0.95]',
		className
	)}
	onclick={(event) => {
		event.stopPropagation();
		event.preventDefault();
		void handleCopy(code);
	}}
	aria-label={copied ? 'Copied code' : 'Copy code'}
>
	<span class="sr-only">{copied ? 'Copied code' : 'Copy code'}</span>
	<span
		class={cn(
			'absolute transition-[opacity,filter,scale] duration-150 ease-out will-change-[opacity,filter,scale]',
			copied ? 'scale-[0.25] opacity-0 blur-xs' : 'blur-0 scale-100 opacity-100'
		)}
	>
		<Copy size={16} />
	</span>
	<span
		class={cn(
			'absolute transition-[opacity,filter,scale] duration-150 ease-out will-change-[opacity,filter,scale]',
			copied ? 'blur-0 scale-100 opacity-100' : ' scale-[0.25] opacity-0 blur-xs'
		)}
	>
		<Checkmark size={16} />
	</span>
</button>
