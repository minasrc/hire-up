"use client";

import { usePathname } from 'next/navigation';
import Footer from './Footer';

// Public chrome stays out of /staff — the fixed header otherwise overlays
// the workspace's top content and swallows clicks.
export default function FooterVisibility() {
    const pathname = usePathname();
    if (pathname?.startsWith('/staff') || pathname === '/dev/duplicate-review') {
        return null;
    }
    return <Footer />;
}
