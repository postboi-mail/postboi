<script lang="ts">
	import { afterNavigate } from "$app/navigation"
	import { resolve } from "$app/paths"
	import { onDestroy } from "svelte"
	import ContentSidebar from "$lib/components/content/ContentSidebar.svelte"
	import { brandingConfig } from "$lib/config/branding"
	import { contentUiDefaults, type SectionUiConfig } from "$lib/config/content-ui"
	import { getContentSectionLinks } from "$lib/content/sections"
	import { siteConfig } from "$lib/config/site"
	import Menu from "carbon-icons-svelte/lib/Menu.svelte"
	import Close from "carbon-icons-svelte/lib/Close.svelte"
	import type { ContentItem, ContentSectionLink } from "$lib/config/navigation"

	const defaultSectionLinks = getContentSectionLinks()

	const {
		navigation = [],
		navigationLabel = contentUiDefaults.sidebar.navigationLabel,
		basePath = "/",
		showSearch = contentUiDefaults.search.enabled,
		showThemeToggle = contentUiDefaults.sidebar.showThemeToggle,
		showRepositoryLink = contentUiDefaults.sidebar.showRepositoryLink,
		repositoryUrl = siteConfig.links.github,
		repositoryAriaLabel = contentUiDefaults.sidebar.repositoryAriaLabel,
		searchConfig = contentUiDefaults.search,
		sectionLinks = defaultSectionLinks,
	}: {
		navigation?: ContentItem[]
		navigationLabel?: string
		basePath?: string
		showSearch?: boolean
		showThemeToggle?: boolean
		showRepositoryLink?: boolean
		repositoryUrl?: string
		repositoryAriaLabel?: string
		searchConfig?: SectionUiConfig["search"]
		sectionLinks?: ContentSectionLink[]
	} = $props()

	let isOpen = $state(false)
	let isVisible = $state(false)
	let restoreFocusEl: HTMLElement | null = null
	const canUseDocument = typeof document !== "undefined"
	const panelId = "mobile-sidebar-panel"
	const toggleButtonId = "mobile-sidebar-toggle"
	const closeButtonId = "mobile-sidebar-close"

	function setBodyOverflow(value: string) {
		if (!canUseDocument) return
		document.body.style.overflow = value
	}

	function getPanelElement() {
		if (!canUseDocument) return null
		const node = document.getElementById(panelId)
		return node instanceof HTMLDivElement ? node : null
	}

	function getToggleButton() {
		if (!canUseDocument) return null
		const node = document.getElementById(toggleButtonId)
		return node instanceof HTMLButtonElement ? node : null
	}

	function getCloseButton() {
		if (!canUseDocument) return null
		const node = document.getElementById(closeButtonId)
		return node instanceof HTMLButtonElement ? node : null
	}

	function open() {
		const activeElement =
			canUseDocument && document.activeElement instanceof HTMLElement
				? document.activeElement
				: null
		restoreFocusEl = activeElement instanceof HTMLElement ? activeElement : getToggleButton()
		setBodyOverflow("hidden")

		if (isVisible) {
			isOpen = true
			requestAnimationFrame(() => {
				getCloseButton()?.focus()
			})
			return
		}

		isVisible = true
		requestAnimationFrame(() => {
			isOpen = true
			getCloseButton()?.focus()
		})
	}

	function toggle() {
		if (isOpen) {
			close()
			return
		}

		open()
	}

	function close(options: { restoreFocus?: boolean } = {}) {
		const { restoreFocus = true } = options
		isOpen = false
		setBodyOverflow("")

		if (restoreFocus) {
			restoreFocusEl?.focus()
		}

		restoreFocusEl = null
	}

	function closePanel() {
		close()
	}

	function getFocusableElements() {
		const panel = getPanelElement()
		if (!panel) return []
		const selector =
			'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
		return Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter(
			(element) =>
				!element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true"
		)
	}

	function handleTabKey(event: KeyboardEvent) {
		const panel = getPanelElement()
		if (!panel) return

		const focusable = getFocusableElements()
		if (focusable.length === 0) {
			event.preventDefault()
			return
		}

		const first = focusable[0]
		const last = focusable[focusable.length - 1]
		const activeElement =
			canUseDocument && document.activeElement instanceof HTMLElement
				? document.activeElement
				: null

		if (event.shiftKey) {
			if (!activeElement || activeElement === first || !panel.contains(activeElement)) {
				event.preventDefault()
				last.focus()
			}
			return
		}

		if (!activeElement || activeElement === last || !panel.contains(activeElement)) {
			event.preventDefault()
			first.focus()
		}
	}

	function handleDocumentKeydown(event: KeyboardEvent) {
		if (!isOpen) return

		if (event.key === "Escape") {
			event.preventDefault()
			close()
			return
		}

		if (event.key === "Tab") {
			handleTabKey(event)
		}
	}

	function handleSidebarTransitionEnd(event: TransitionEvent) {
		if (event.target !== event.currentTarget || event.propertyName !== "transform") return
		if (!isOpen) isVisible = false
	}

	afterNavigate(() => {
		close({ restoreFocus: false })
	})

	onDestroy(() => {
		setBodyOverflow("")
	})
</script>

<svelte:document onkeydown={handleDocumentKeydown} />

<div
	class="fixed inset-x-0 top-0 z-50 flex items-center justify-between border-b border-border bg-background px-4 py-1.5 lg:hidden"
>
	<a
		href={resolve("/")}
		class="inline-flex items-center gap-1 px-2 py-2 text-sm tracking-tight text-foreground transition-colors duration-150 ease-out hover:text-foreground"
	>
		<span
			class="inline-flex shrink-0 items-center text-accent [&>svg]:size-4 [&>svg]:fill-current"
			aria-hidden="true"
		>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html brandingConfig.logoRaw}
		</span>
		<span class="font-medium tracking-tight text-foreground">{brandingConfig.name}</span>
	</a>
	<button
		id={toggleButtonId}
		onclick={toggle}
		class="-mr-2 inline-flex size-10 items-center justify-center gap-2 rounded-sm text-sm whitespace-nowrap text-foreground transition-colors duration-150 ease-out hover:bg-background-muted lg:hidden"
		aria-label="Toggle menu"
	>
		<Menu size={20} />
	</button>
</div>

{#if isVisible}
	<div
		class="overlay fixed inset-0 z-50 bg-background-inset/80 backdrop-blur-sm lg:hidden"
		class:active={isOpen}
		onclick={closePanel}
		role="button"
		tabindex="-1"
		onkeydown={(event) => {
			if (event.key === "Escape") closePanel()
		}}
		aria-label="Close sidebar"
		aria-hidden={!isOpen}
	></div>

	<div
		id={panelId}
		class="sidebar fixed inset-y-0 right-0 z-50 w-3/4 max-w-sm overflow-hidden border-l border-border bg-background-inset text-foreground-muted lg:hidden"
		class:active={isOpen}
		role="dialog"
		aria-modal="true"
		aria-label={navigationLabel}
		ontransitionend={handleSidebarTransitionEnd}
	>
		<div class="absolute top-0 right-0 flex justify-end p-4">
			<button id={closeButtonId} onclick={closePanel} aria-label="Close menu">
				<Close size={32} class="size-6" />
			</button>
		</div>

		<ContentSidebar
			{navigation}
			{navigationLabel}
			{basePath}
			{showSearch}
			{showThemeToggle}
			{showRepositoryLink}
			{repositoryUrl}
			{repositoryAriaLabel}
			{searchConfig}
			{sectionLinks}
		/>
	</div>
{/if}

<style>
	.overlay {
		opacity: 0;
		pointer-events: none;
		transition: opacity 200ms ease-out;
		will-change: opacity;
	}

	.overlay.active {
		opacity: 1;
		pointer-events: auto;
	}

	.sidebar {
		transform: translateX(100%);
		transition: transform 200ms ease-out;
		will-change: transform;
	}

	.sidebar.active {
		transform: translateX(0);
	}
</style>
