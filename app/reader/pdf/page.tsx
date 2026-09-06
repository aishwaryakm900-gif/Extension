"use client";

import dynamic from "next/dynamic";

const PdfReader = dynamic(() => import("../../../components/reader/PdfReader"), {
  ssr: false,
});

export default function PdfReaderPage() {
  return <PdfReader />;
}

