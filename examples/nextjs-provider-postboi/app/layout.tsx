export const metadata = {
	title: "Next.js × Postboi",
	description: "Contact form powered by postboi",
}

export default function RootLayout({
	children,
}: {
	children: React.ReactNode
}) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	)
}
