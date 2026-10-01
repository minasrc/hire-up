export default function StaffLoading() {
    return (
        <section
            role="status"
            aria-busy="true"
            aria-label="Loading page"
            className="mx-auto flex w-full max-w-7xl flex-col gap-6"
        >
            <span className="sr-only">Loading page…</span>
            <div aria-hidden="true" className="flex flex-col gap-3 motion-safe:animate-pulse">
                <div className="h-3 w-20 rounded bg-secondary" />
                <div className="h-8 w-48 rounded bg-secondary" />
                <div className="h-4 w-64 max-w-full rounded bg-secondary" />
            </div>
            <div
                aria-hidden="true"
                className="overflow-hidden rounded-lg border border-border bg-card motion-safe:animate-pulse"
            >
                <div className="h-14 border-b border-border bg-secondary/50" />
                {Array.from({ length: 5 }, (_, index) => (
                    <div key={index} className="flex gap-6 border-b border-border p-5 last:border-0">
                        <div className="h-4 w-1/3 rounded bg-secondary" />
                        <div className="h-4 w-1/4 rounded bg-secondary" />
                    </div>
                ))}
            </div>
        </section>
    );
}
