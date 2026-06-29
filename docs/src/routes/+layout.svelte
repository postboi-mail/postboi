<script lang="ts">
	import "./layout.css"
	import {
		CommandPalette,
		ContentNavigation,
		DocShareActions,
		MobileDocShareActions,
		TableOfContents,
		contentUiDefaults,
		resolveRepositoryFileUrl,
		resolveTocSelector,
		siteConfig,
	} from "$lib"
	import ContentSectionLayout from "$lib/components/content/ContentSectionLayout.svelte"
	import {
		getContentSectionConfig,
		getContentSectionHref,
		getContentSectionLinks,
		getContentSectionManifest,
		getContentSectionRawHref,
		getContentSectionUiConfig,
	} from "$lib/content/sections"
	import type { SectionUiConfig } from "$lib/config/content-ui"
	import type { LayoutData } from "./$types"
	import type { Snippet } from "svelte"

	const { data, children }: { data: LayoutData; children: Snippet } = $props()

	const sectionId = $derived(data.sectionId)
	const sectionUi = $derived<SectionUiConfig>(getContentSectionUiConfig(sectionId))
	const sectionConfig = $derived(getContentSectionConfig(sectionId))
	const sectionManifest = $derived(getContentSectionManifest(sectionId))
	const sectionBasePath = ""

	const metadata = $derived(data.metadata)
	const docSlug = $derived(metadata?.slug)
	const isHome = $derived(docSlug === "" || docSlug == null)
	const currentDoc = $derived(sectionManifest.find((d) => d.slug === docSlug))

	const previousLink = $derived(
		data.previousDoc
			? {
					title: data.previousDoc.name,
					href: getContentSectionHref(sectionId, data.previousDoc.slug),
				}
			: null
	)
	const nextLink = $derived(
		data.nextDoc
			? {
					title: data.nextDoc.name,
					href: getContentSectionHref(sectionId, data.nextDoc.slug),
				}
			: null
	)

	const siteOrigin = new URL(siteConfig.url).origin
	const canonicalUrl = $derived(metadata ? new URL(metadata.href, siteOrigin).href : null)

	const docOgImage = $derived(
		sectionUi.pageActions.enabled && metadata
			? new URL(`/og/${metadata.slug || "index"}`, siteOrigin).href
			: new URL(siteConfig.ogImage, siteOrigin).href
	)

	const docTitle = $derived(metadata?.title ?? currentDoc?.name ?? siteConfig.name)
	const pageTitle = $derived(
		isHome
			? `${siteConfig.name} — ${siteConfig.description.split(".")[0]}`
			: `${docTitle} - ${siteConfig.name}`
	)
	const docDescription = $derived(metadata?.description ?? siteConfig.description)

	const docStructuredData = $derived.by(() => {
		if (!canonicalUrl) return null
		return JSON.stringify({
			"@context": "https://schema.org",
			"@type": "TechArticle",
			headline: docTitle,
			description: docDescription,
			url: canonicalUrl,
			author: { "@type": "Person", name: siteConfig.author },
			publisher: { "@type": "Organization", name: siteConfig.name },
			mainEntityOfPage: canonicalUrl,
		})
	})

	const rawPath = $derived(metadata ? getContentSectionRawHref(sectionId, metadata.slug) : null)
	const docOrigin = $derived(data.docOrigin)
	const rawUrl = $derived(rawPath && docOrigin ? new URL(rawPath, docOrigin).href : null)

	const repoRelativePath = $derived(
		metadata ? `/src/lib/content/${sectionId}/${metadata.slug || "index"}.svx` : null
	)
	const githubUrl = $derived(
		repoRelativePath
			? resolveRepositoryFileUrl(sectionUi.pageActions, siteConfig.links.github, repoRelativePath)
			: null
	)

	const showDocActions = $derived(sectionUi.pageActions.enabled && Boolean(metadata))
	const showToc = $derived(sectionUi.toc.enabled)
	const showRightAside = $derived(sectionUi.toc.enabled || sectionUi.pageActions.enabled)
	const isSvxContent = $derived(metadata?.sourceType === "svx")
	const innerViewportStyle = $derived(isSvxContent)
	const showPagination = $derived(
		sectionUi.pagination.enabled && (isSvxContent || Boolean(currentDoc?.showPagination))
	)

	const searchConfig = $derived<SectionUiConfig["search"]>(
		sectionUi.search ?? contentUiDefaults.search
	)
	const showCommandPalette = $derived(searchConfig.enabled)

	const sectionLinks = getContentSectionLinks()
	const sidebarConfig = $derived({
		navigation: sectionConfig.navigation,
		navigationLabel: sectionUi.sidebar.navigationLabel,
		basePath: sectionBasePath,
		showSearch: sectionUi.search.enabled,
		showThemeToggle: sectionUi.sidebar.showThemeToggle,
		showRepositoryLink: sectionUi.sidebar.showRepositoryLink,
		repositoryUrl: siteConfig.links.github,
		repositoryAriaLabel: sectionUi.sidebar.repositoryAriaLabel,
		searchConfig: sectionUi.search,
		sectionLinks,
	})

	const tocSelector = $derived(resolveTocSelector(sectionUi.toc, docSlug))
	const mainId = $derived(`${sectionId}-main-content`)
	const scrollContainerId = $derived(`${sectionId}-content-container`)
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content={docDescription} />
	{#if canonicalUrl}<link rel="canonical" href={canonicalUrl} />{/if}
	<meta name="author" content={siteConfig.author} />
	<meta name="keywords" content={siteConfig.keywords.join(", ")} />

	<meta name="theme-color" content="#ffffff" />
	<meta
		name="docs-package-manager-storage-key"
		content={contentUiDefaults.packageManager.storageKey}
	/>
	<meta name="docs-package-manager-default" content={contentUiDefaults.packageManager.default} />
	<meta
		name="docs-package-manager-enabled"
		content={contentUiDefaults.packageManager.enabled.join(",")}
	/>

	<meta property="og:site_name" content={siteConfig.name} />
	<meta property="og:locale" content="en_US" />
	<meta property="og:type" content={isHome ? "website" : "article"} />
	<meta property="og:title" content={pageTitle} />
	<meta property="og:description" content={docDescription} />
	{#if canonicalUrl}<meta property="og:url" content={canonicalUrl} />{/if}
	<meta property="og:image" content={docOgImage} />
	<meta property="og:image:alt" content={`${siteConfig.name} documentation`} />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={pageTitle} />
	<meta name="twitter:description" content={docDescription} />
	<meta name="twitter:image" content={docOgImage} />

	<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
	<link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png" />
	<link rel="icon" type="image/x-icon" href="/favicon.ico" />
	<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
	<link rel="manifest" href="/site.webmanifest" />
	<link rel="mask-icon" href="/favicon.svg" color="#1f2125" />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
	<meta name="apple-mobile-web-app-title" content={siteConfig.name} />

	{#if docStructuredData}
		<svelte:element this={"script"} type="application/ld+json">
			{docStructuredData}
		</svelte:element>
	{/if}
</svelte:head>

{#if showCommandPalette}
	<CommandPalette {searchConfig} />
{/if}

<ContentSectionLayout
	{mainId}
	{scrollContainerId}
	showAside={showRightAside}
	{innerViewportStyle}
	{sidebarConfig}
>
	{#snippet main()}
		<section class="flex min-w-0 flex-1 flex-col space-y-8">
			{#if metadata?.sourceType === "svx"}
				<div class="space-y-4">
					{#if currentDoc?.category}
						<p class="mb-2 text-sm font-medium tracking-normal text-foreground-muted/70 capitalize">
							{currentDoc.category}
						</p>
					{/if}
					<h1 class="scroll-m-20 text-3xl font-medium tracking-tight text-foreground">
						{metadata.title}
					</h1>
					{#if metadata.description}
						<p class="max-w-4xl text-base font-normal tracking-normal text-foreground-muted">
							{metadata.description}
						</p>
					{/if}

					{#if showDocActions}
						<MobileDocShareActions
							{rawPath}
							{rawUrl}
							{githubUrl}
							pageActionsConfig={sectionUi.pageActions}
						/>
					{/if}
				</div>
				<hr
					class="h-px border-0 bg-border shadow-2xs shadow-white dark:bg-black dark:shadow-border"
				/>
			{/if}

			<div class="flex-1">
				{@render children()}

				<ContentNavigation
					previous={previousLink}
					next={nextLink}
					paginationConfig={sectionUi.pagination}
					enabled={showPagination}
				/>
			</div>
		</section>
	{/snippet}

	{#snippet aside()}
		{#if showRightAside}
			<aside
				class="z-50 hidden max-h-full min-h-0 w-56 flex-col justify-between overflow-hidden py-8 xl:col-start-2 xl:row-start-1 xl:flex 2xl:col-start-3"
				aria-label="Table of contents and document actions"
			>
				{#if showToc}
					<div class="min-h-0 flex-1">
						<TableOfContents
							selector={tocSelector}
							headings={data.tocHeadings}
							title={sectionUi.toc.title}
							emptyLabel={sectionUi.toc.emptyLabel}
							minViewportWidth={sectionUi.toc.minViewportWidth}
							{scrollContainerId}
						/>
					</div>
				{/if}
				{#if showDocActions}
					<DocShareActions
						{rawPath}
						{rawUrl}
						{githubUrl}
						pageActionsConfig={sectionUi.pageActions}
					/>
				{/if}
			</aside>
		{/if}
	{/snippet}
</ContentSectionLayout>
