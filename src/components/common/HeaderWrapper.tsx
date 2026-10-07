"use client";

import { usePathname } from 'next/navigation';
import Header from './Header';
import useScrollHandler from '@/hooks/useScrollHandler';

const HeaderWrapper = () => {
    const pathname = usePathname();
    const isHeaderVisible = useScrollHandler();

    if (pathname?.startsWith('/staff') || pathname === '/dev/duplicate-review') {
        return null;
    }
    return <Header isVisible={isHeaderVisible} />;
};

export default HeaderWrapper;
