import { generateJSON } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { editorJobDocument } from '@/lib/editor-job-document.js';

// Read the displayed draft at the action boundary, including edits whose callback
// snapshot was replaced during local Fast Refresh. Use the same allowed schema
// as RichTextEditor; the job contract still validates the resulting document.
export function readJobEditor(root: ParentNode | null, fallback: unknown): unknown {
    const element = root?.querySelector<HTMLElement>('[aria-label="Job description"][contenteditable]');
    if (!element) return editorJobDocument(fallback);
    return editorJobDocument(generateJSON(element.innerHTML, [StarterKit.configure({
        heading: { levels: [2, 3] },
        code: false,
        codeBlock: false,
        horizontalRule: false,
        trailingNode: false,
        link: {
            openOnClick: false,
            autolink: false,
            linkOnPaste: true,
            protocols: ['http', 'https'],
        },
    })]));
}
