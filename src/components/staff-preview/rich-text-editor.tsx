'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
    Bold,
    Heading2,
    Heading3,
    Italic,
    Link2,
    List,
    ListOrdered,
    Pilcrow,
    Redo2,
    Strikethrough,
    Underline,
    Undo2,
} from 'lucide-react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

import { Button } from '@/components/staff-ui/button';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { EMPTY_JOB_DOCUMENT } from '@/lib/client-job-contracts.js';
import { cn } from '@/lib/utils';

import { RequiredMark } from './shared';

const LINK_URL_PATTERN = /^https?:\/\/\S+$/;

const EDITOR_CLASS = [
    'min-h-44 w-full px-3 py-2 text-sm leading-6 text-foreground outline-none',
    '[&_p]:my-1.5 [&_p]:first:mt-0 [&_p]:last:mb-0',
    '[&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wide',
    '[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold',
    '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5',
    '[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5',
    '[&_li]:my-0.5',
    '[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic',
    '[&_a]:text-accent-foreground [&_a]:underline',
].join(' ');

export function RichTextEditor({
    initialDocument,
    onDocumentChange,
    invalid,
    disabled: isDisabled = false,
}: {
    initialDocument?: unknown;
    onDocumentChange?: (document: unknown) => void;
    invalid?: boolean;
    disabled?: boolean;
}) {
    const [linkOpen, setLinkOpen] = useState(false);
    const [linkUrl, setLinkUrl] = useState('');
    const [linkError, setLinkError] = useState<string | null>(null);

    const editor = useEditor({
        immediatelyRender: false,
        editable: !isDisabled,
        extensions: [
            StarterKit.configure({
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
            }),
        ],
        content: (initialDocument ?? EMPTY_JOB_DOCUMENT) as never,
        onUpdate: ({ editor: instance }) => onDocumentChange?.(instance.getJSON()),
        editorProps: {
            attributes: {
                class: EDITOR_CLASS,
                'aria-label': 'Job description',
                'aria-required': 'true',
                role: 'textbox',
                'aria-multiline': 'true',
                ...(invalid ? { 'aria-invalid': 'true' } : {}),
            },
        },
    });

    useEffect(() => {
        editor?.setEditable(!isDisabled, false);
    }, [editor, isDisabled]);

    const editorState = useEditorState({
        editor,
        selector: (context) =>
            context.editor
                ? {
                      paragraph: context.editor.isActive('paragraph'),
                      heading2: context.editor.isActive('heading', { level: 2 }),
                      heading3: context.editor.isActive('heading', { level: 3 }),
                      bold: context.editor.isActive('bold'),
                      italic: context.editor.isActive('italic'),
                      underline: context.editor.isActive('underline'),
                      strike: context.editor.isActive('strike'),
                      bulletList: context.editor.isActive('bulletList'),
                      orderedList: context.editor.isActive('orderedList'),
                      link: context.editor.isActive('link'),
                      canUndo: context.editor.can().undo(),
                      canRedo: context.editor.can().redo(),
                  }
                : null,
    });

    const toolButton = (
        label: string,
        icon: ReactNode,
        onPress: () => void,
        pressed?: boolean,
        disabled?: boolean,
    ) => (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8', pressed && 'bg-hover text-foreground')}
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled || isDisabled || !editor}
            onClick={onPress}
        >
            {icon}
        </Button>
    );

    const applyLink = () => {
        if (!editor) return;
        const url = linkUrl.trim();
        if (!LINK_URL_PATTERN.test(url)) {
            setLinkError('Enter a full http(s) URL, e.g. https://example.com');
            return;
        }
        setLinkError(null);
        const chain = editor.chain().focus().extendMarkRange('link');
        if (editor.state.selection.empty) {
            chain
                .insertContent({
                    type: 'text',
                    text: url,
                    marks: [{ type: 'link', attrs: { href: url } }],
                })
                .run();
        } else {
            chain.setLink({ href: url }).run();
        }
        setLinkOpen(false);
        setLinkUrl('');
    };

    return (
        <div
            className={cn(
                'flex flex-col rounded-lg border bg-card transition-colors',
                invalid ? 'border-destructive' : 'border-input',
                'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background',
            )}
        >
            <div
                className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1.5"
                role="toolbar"
                aria-label="Job description formatting"
            >
                {toolButton('Paragraph', <Pilcrow aria-hidden="true" />, () =>
                    editor?.chain().focus().setParagraph().run(), editorState?.paragraph)}
                {toolButton('Heading 2', <Heading2 aria-hidden="true" />, () =>
                    editor?.chain().focus().toggleHeading({ level: 2 }).run(),
                    editorState?.heading2)}
                {toolButton('Heading 3', <Heading3 aria-hidden="true" />, () =>
                    editor?.chain().focus().toggleHeading({ level: 3 }).run(),
                    editorState?.heading3)}
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
                {toolButton('Bold', <Bold aria-hidden="true" />, () =>
                    editor?.chain().focus().toggleBold().run(), editorState?.bold)}
                {toolButton('Italic', <Italic aria-hidden="true" />, () =>
                    editor?.chain().focus().toggleItalic().run(), editorState?.italic)}
                {toolButton('Underline', <Underline aria-hidden="true" />, () =>
                    editor?.chain().focus().toggleUnderline().run(), editorState?.underline)}
                {toolButton('Strikethrough', <Strikethrough aria-hidden="true" />, () =>
                    editor?.chain().focus().toggleStrike().run(), editorState?.strike)}
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
                {toolButton('Bullet list', <List aria-hidden="true" />, () =>
                    editor?.chain().focus().toggleBulletList().run(), editorState?.bulletList)}
                {toolButton('Numbered list', <ListOrdered aria-hidden="true" />, () =>
                    editor?.chain().focus().toggleOrderedList().run(), editorState?.orderedList)}
                {toolButton('Link', <Link2 aria-hidden="true" />, () => {
                    setLinkOpen((open) => !open);
                    setLinkError(null);
                    if (editor?.isActive('link')) {
                        setLinkUrl(String(editor.getAttributes('link').href ?? ''));
                    }
                }, editorState?.link)}
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
                {toolButton('Undo', <Undo2 aria-hidden="true" />, () =>
                    editor?.chain().focus().undo().run(), undefined, !editorState?.canUndo)}
                {toolButton('Redo', <Redo2 aria-hidden="true" />, () =>
                    editor?.chain().focus().redo().run(), undefined, !editorState?.canRedo)}
            </div>

            {linkOpen ? (
                <div className="flex flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-end">
                    <div className="flex flex-1 flex-col gap-1">
                        <Label htmlFor="job-description-link-url" className="text-xs">
                            Link URL <RequiredMark />
                        </Label>
                        <Input
                            id="job-description-link-url"
                            required
                            aria-required="true"
                            value={linkUrl}
                            onChange={(event) => setLinkUrl(event.target.value)}
                            placeholder="https://…"
                            aria-invalid={linkError ? 'true' : undefined}
                            aria-describedby={linkError ? 'job-description-link-error' : undefined}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    applyLink();
                                }
                            }}
                        />
                        {linkError ? (
                            <p id="job-description-link-error" role="alert" className="text-xs text-destructive">
                                {linkError}
                            </p>
                        ) : null}
                    </div>
                    <div className="flex gap-2">
                        <Button type="button" size="sm" onClick={applyLink}>
                            Apply link
                        </Button>
                        {editorState?.link ? (
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
                                    setLinkOpen(false);
                                    setLinkUrl('');
                                }}
                            >
                                Remove link
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : null}

            <EditorContent editor={editor} />
        </div>
    );
}
