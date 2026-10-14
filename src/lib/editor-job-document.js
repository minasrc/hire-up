// Tiptap includes presentation-only attributes that aren't stored in job documents.
// Remove only those known attributes; the contract still validates everything else.
export function editorJobDocument(value, depth = 0) {
    if (depth > 12 || !value || typeof value !== 'object' || Array.isArray(value)) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const node = { ...value };
    if (node.type === 'orderedList' && node.attrs && typeof node.attrs === 'object' && !Array.isArray(node.attrs)) {
        const attrs = { ...node.attrs };
        delete attrs.type;
        node.attrs = attrs;
    }
    if (Array.isArray(node.marks)) {
        node.marks = node.marks.map((mark) => {
            if (mark?.type !== 'link' || !mark.attrs || typeof mark.attrs !== 'object' || Array.isArray(mark.attrs)) return mark;
            const attrs = { ...mark.attrs };
            delete attrs.title;
            return { ...mark, attrs };
        });
    }
    if (Array.isArray(node.content)) node.content = node.content.map((child) => editorJobDocument(child, depth + 1));
    return node;
}
