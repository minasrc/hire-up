import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, Upload, Check } from 'lucide-react';
import confetti from 'canvas-confetti';
import {
    CV_ACCEPT_ATTRIBUTE,
    isApplicationReference,
    normalizeProfessionalUrl,
    validateApplicationFields,
    validateCvFileMetadata,
} from '@/lib/application';

interface JobSummary {
    id: string;
    title: string;
}

type JobAvailability = 'open' | 'unavailable' | 'unknown';

interface SignalSubmissionModalProps {
    isOpen: boolean;
    onClose: () => void;
    job?: JobSummary | null;
    availability?: JobAvailability;
    onCheckAvailability?: () => Promise<boolean>;
    onJobUnavailable?: () => void;
}

const SignalSubmissionModal: React.FC<SignalSubmissionModalProps> = ({
    isOpen,
    onClose,
    job,
    availability = 'open',
    onCheckAvailability,
    onJobUnavailable,
}) => {
    const [step, setStep] = useState<'initial' | 'submitting' | 'success'>('initial');
    const [errorMessage, setErrorMessage] = useState('');
    const [professionalUrlError, setProfessionalUrlError] = useState('');
    const [checking, setChecking] = useState(false);
    const generationRef = useRef(0);
    const busyRef = useRef(false);
    const submissionRef = useRef<{ signature: string; id: string } | null>(null);
    const [availabilityOverride, setAvailabilityOverride] = useState<JobAvailability | null>(null);
    const [seenAvailability, setSeenAvailability] = useState(availability);
    if (seenAvailability !== availability) {
        setSeenAvailability(availability);
        setAvailabilityOverride(null);
    }
    const effectiveAvailability = availabilityOverride ?? availability;
    const [data, setData] = useState({
        fullName: '',
        email: '',
        professionalUrl: '',
        technicalAchievement: ''
    });
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [terminalLines, setTerminalLines] = useState<string[]>([]);
    const [website, setWebsite] = useState('');
    const [submissionRefId, setSubmissionRefId] = useState('');

    useEffect(() => {
        generationRef.current += 1;
        busyRef.current = false;
        if (!isOpen) {
            return () => {
                generationRef.current += 1;
                busyRef.current = false;
            };
        }
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        setStep('initial');
        setErrorMessage('');
        setProfessionalUrlError('');
        setChecking(false);
        setAvailabilityOverride(null);
        setTerminalLines([]);
        setSelectedFile(null);
        setWebsite('');
        setSubmissionRefId('');
        submissionRef.current = null;
        setData({
            fullName: '',
            email: '',
            professionalUrl: '',
            technicalAchievement: '',
        });
        return () => {
            generationRef.current += 1;
            busyRef.current = false;
            document.body.style.overflow = previousOverflow;
        };
    }, [isOpen, job?.id]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        if (name === 'professionalUrl') {
            setProfessionalUrlError('');
        }
        setData(prev => ({ ...prev, [name]: value }));
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setErrorMessage('');
            const validation = validateCvFileMetadata(file);
            if (!validation.ok) {
                setSelectedFile(null);
                setErrorMessage(validation.message);
                e.target.value = '';
                return;
            }

            setSelectedFile(file);
        }
    };

    const handleProfessionalUrlBlur = () => {
        const result = normalizeProfessionalUrl(data.professionalUrl);
        if (!result.ok) {
            setProfessionalUrlError(result.message);
            return;
        }

        setProfessionalUrlError('');
        if (result.value !== data.professionalUrl) {
            setData(previous => ({ ...previous, professionalUrl: result.value }));
        }
    };

    const recheckAvailability = async () => {
        if (!onCheckAvailability || busyRef.current) return;
        const generation = generationRef.current;
        busyRef.current = true;
        setChecking(true);
        try {
            const available = await onCheckAvailability();
            if (generationRef.current !== generation) return;
            setAvailabilityOverride(available ? 'open' : 'unavailable');
            setErrorMessage('');
        } catch {
            if (generationRef.current !== generation) return;
            setAvailabilityOverride('unknown');
        } finally {
            if (generationRef.current === generation) {
                busyRef.current = false;
                setChecking(false);
            }
        }
    };

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!isOpen || busyRef.current || effectiveAvailability !== 'open') return;
        const generation = generationRef.current;

        const fieldValidation = validateApplicationFields({
            jobId: job?.id || '',
            ...data,
        }, job ? [job] : []);

        if (!fieldValidation.ok) {
            if (fieldValidation.code === 'INVALID_URL') {
                setProfessionalUrlError(fieldValidation.message);
                setErrorMessage('');
                return;
            }
            setErrorMessage(fieldValidation.message);
            return;
        }

        if (!selectedFile) {
            setErrorMessage('Attach your CV as a PDF or DOCX file.');
            return;
        }

        busyRef.current = true;
        setChecking(true);
        try {
            if (onCheckAvailability) {
                try {
                    const stillOpen = await onCheckAvailability();
                    if (generationRef.current !== generation) return;
                    if (!stillOpen) {
                        setAvailabilityOverride('unavailable');
                        setErrorMessage('');
                        return;
                    }
                    setAvailabilityOverride(null);
                } catch {
                    if (generationRef.current !== generation) return;
                    setAvailabilityOverride('unknown');
                    setErrorMessage('');
                    return;
                }
            }

            const formData = new FormData();
            const signature = JSON.stringify([
                fieldValidation.job.id,
                fieldValidation.fields,
                selectedFile.name,
                selectedFile.size,
                selectedFile.lastModified,
            ]);
            if (submissionRef.current?.signature !== signature) {
                submissionRef.current = { signature, id: crypto.randomUUID() };
            }
            formData.append('submissionId', submissionRef.current.id);
            formData.append('jobId', fieldValidation.job.id);
            formData.append('fullName', fieldValidation.fields.fullName);
            formData.append('email', fieldValidation.fields.email);
            formData.append('professionalUrl', fieldValidation.fields.professionalUrl);
            formData.append('technicalAchievement', fieldValidation.fields.technicalAchievement);
            formData.append('website', website);
            formData.append('cvFile', selectedFile);

            setErrorMessage('');
            setStep('submitting');
            setTerminalLines([
                '> VALIDATING_APPLICATION...',
                '> UPLOADING_CV...',
            ]);

            const response = await fetch('/api/submit-signal', {
                method: 'POST',
                body: formData,
            });

            const result = await response.json().catch(() => null);
            if (generationRef.current !== generation) return;

            if (response.ok && result?.success && isApplicationReference(result.refId)) {
                setSubmissionRefId(result.refId);
                setTerminalLines(prev => [...prev, "> SIGNAL_RECEIVED.", "> HANDSHAKE_COMPLETE."]);
                setStep('success');
                confetti({
                    particleCount: 100,
                    spread: 70,
                    origin: { y: 0.6 },
                    colors: ['#22d3ee', '#34d399', '#ffffff']
                });
            } else if (result?.code === 'INVALID_JOB') {
                setAvailabilityOverride('unavailable');
                onJobUnavailable?.();
                setWebsite('');
                setStep('initial');
            } else {
                const unconfirmedMessage = response.ok && result?.success
                    ? 'We could not confirm that your application was saved. Please try again.'
                    : result?.message;
                setErrorMessage(unconfirmedMessage || 'Your application could not be submitted. Please try again.');
                setWebsite('');
                setStep('initial');
            }
        } catch {
            if (generationRef.current !== generation) return;
            setErrorMessage('The connection was interrupted. Please try again.');
            setStep('initial');
        } finally {
            if (generationRef.current === generation) {
                busyRef.current = false;
                setChecking(false);
            }
        }
    };

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-[#020b1a]/80 backdrop-blur-[20px] z-50 flex items-center justify-center p-4"
                    >
                        {/* Modal Container */}
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            onClick={(e) => e.stopPropagation()}
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="signal-submission-title"
                            className="bg-[#020b1a] border border-teal-500/30 w-full max-w-lg max-h-[calc(100vh-2rem)] rounded-2xl shadow-[0_0_40px_rgba(20,184,166,0.1)] overflow-y-auto relative"
                        >
                            {/* Close Button */}
                            <button
                                onClick={onClose}
                                aria-label="Close application form"
                                className="absolute top-4 right-4 text-teal-500/50 hover:text-teal-400 transition-colors"
                            >
                                <X size={20} />
                            </button>

                            {/* Header */}
                            <div className="p-8 pb-0">
                                <div className="flex items-center space-x-3 mb-2">
                                    <h2 id="signal-submission-title" className="text-2xl font-bold text-white font-outfit">Signal Submission</h2>
                                    <CheckCircle className="text-blue-500 fill-blue-500/20" size={20} />
                                </div>
                                <p className="text-gray-400 text-sm font-outfit">
                                    Applying for: <span className="text-teal-400">{job?.title || 'Position'}</span>
                                </p>
                            </div>

                            <div className="p-8 pt-6">
                                {step === 'initial' && (
                                    <motion.div
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        className="space-y-6"
                                    >
                                        {/* Minimalist Form */}
                                        <form onSubmit={handleSubmit} noValidate className="space-y-4">
                                            <label hidden aria-hidden="true">
                                                Leave this field empty
                                                <input
                                                    type="text"
                                                    name="website"
                                                    tabIndex={-1}
                                                    autoComplete="new-password"
                                                    data-lpignore="true"
                                                    data-1p-ignore="true"
                                                    value={website}
                                                    onChange={(event) => setWebsite(event.target.value)}
                                                />
                                            </label>

                                            {effectiveAvailability === 'unavailable' && (
                                                <div
                                                    role="alert"
                                                    className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
                                                >
                                                    This position is no longer accepting applications.
                                                </div>
                                            )}
                                            {effectiveAvailability === 'unknown' && (
                                                <div
                                                    role="alert"
                                                    className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
                                                >
                                                    <span>
                                                        We could not confirm this position is
                                                        still open.
                                                    </span>
                                                    <button
                                                        type="button"
                                                        disabled={checking}
                                                        onClick={() => void recheckAvailability()}
                                                        className="ml-2 font-mono text-xs uppercase tracking-wider underline-offset-4 hover:underline disabled:opacity-60"
                                                    >
                                                        Retry
                                                    </button>
                                                </div>
                                            )}
                                            {errorMessage && (
                                                <div
                                                    role="alert"
                                                    className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
                                                >
                                                    {errorMessage}
                                                </div>
                                            )}

                                            <div className="space-y-4">
                                                <label htmlFor="application-full-name" className="sr-only">Full name</label>
                                                <input
                                                    id="application-full-name"
                                                    type="text"
                                                    name="fullName"
                                                    placeholder="Full Name"
                                                    required
                                                    maxLength={120}
                                                    autoComplete="name"
                                                    className="w-full bg-transparent border-b border-white/10 focus:border-teal-500 text-white p-3 outline-none transition-colors placeholder:text-gray-600 font-outfit"
                                                    value={data.fullName}
                                                    onChange={handleInputChange}
                                                />
                                                <label htmlFor="application-email" className="sr-only">Email address</label>
                                                <input
                                                    id="application-email"
                                                    type="email"
                                                    name="email"
                                                    placeholder="Email Address"
                                                    required
                                                    maxLength={254}
                                                    autoComplete="email"
                                                    className="w-full bg-transparent border-b border-white/10 focus:border-teal-500 text-white p-3 outline-none transition-colors placeholder:text-gray-600 font-outfit"
                                                    value={data.email}
                                                    onChange={handleInputChange}
                                                />
                                                <label htmlFor="application-professional-url" className="sr-only">Professional URL</label>
                                                <input
                                                    id="application-professional-url"
                                                    type="text"
                                                    inputMode="url"
                                                    name="professionalUrl"
                                                    placeholder="Professional URL (LinkedIn/GitHub)"
                                                    maxLength={2048}
                                                    autoComplete="url"
                                                    aria-invalid={Boolean(professionalUrlError)}
                                                    aria-describedby={professionalUrlError ? 'application-professional-url-error' : undefined}
                                                    className={`w-full bg-transparent border-b text-white p-3 outline-none transition-colors placeholder:text-gray-600 font-outfit ${professionalUrlError ? 'border-red-400/70 focus:border-red-400' : 'border-white/10 focus:border-teal-500'}`}
                                                    value={data.professionalUrl}
                                                    onChange={handleInputChange}
                                                    onBlur={handleProfessionalUrlBlur}
                                                />
                                                {professionalUrlError && (
                                                    <p
                                                        id="application-professional-url-error"
                                                        role="alert"
                                                        className="px-3 text-sm text-red-200"
                                                    >
                                                        {professionalUrlError}
                                                    </p>
                                                )}
                                                <label htmlFor="application-achievement" className="sr-only">Technical achievement</label>
                                                <textarea
                                                    id="application-achievement"
                                                    name="technicalAchievement"
                                                    placeholder="Briefly describe your core contribution to a Tier 1 protocol..."
                                                    rows={3}
                                                    maxLength={2000}
                                                    className="w-full bg-transparent border-b border-white/10 focus:border-teal-500 text-white p-3 outline-none transition-colors placeholder:text-gray-600 font-outfit resize-none"
                                                    value={data.technicalAchievement}
                                                    onChange={handleInputChange}
                                                />
                                            </div>

                                            {/* CV Upload */}
                                            <div className="border border-dashed border-teal-500/30 rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-teal-500/5 transition-colors group relative">
                                                <Upload className="text-teal-500/50 group-hover:text-teal-400 mb-2 transition-colors" size={24} />
                                                <p className="text-xs text-gray-400 font-mono group-hover:text-teal-200 transition-colors">
                                                    {selectedFile ? `SELECTED: ${selectedFile.name}` : 'DROP_CV_HERE_OR_CLICK_TO_UPLOAD'}
                                                </p>
                                                <input
                                                    id="application-cv"
                                                    type="file"
                                                    name="cvFile"
                                                    className="absolute inset-0 opacity-0 cursor-pointer"
                                                    accept={CV_ACCEPT_ATTRIBUTE}
                                                    required
                                                    aria-label="Upload CV as PDF or DOCX, maximum 4 MB"
                                                    onChange={handleFileChange}
                                                />
                                            </div>

                                            {/* Submit Button */}
                                            <button
                                                type="submit"
                                                disabled={effectiveAvailability !== 'open' || checking}
                                                className="w-full bg-teal-500 hover:bg-teal-400 text-[#020b1a] font-mono font-bold py-3 rounded-xl transition-all duration-300 mt-4 flex items-center justify-center space-x-2 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                <span>{checking ? 'CHECKING_AVAILABILITY...' : 'SUBMIT_SIGNAL'}</span>
                                            </button>
                                        </form>
                                    </motion.div>
                                )}

                                {(step === 'submitting' || step === 'success') && (
                                    <motion.div
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        className="font-mono text-xs space-y-2 h-[400px] flex flex-col justify-end pb-8"
                                    >
                                        {terminalLines.map((line, i) => (
                                            <motion.div
                                                key={i}
                                                initial={{ opacity: 0, x: -10 }}
                                                animate={{ opacity: 1, x: 0 }}
                                                className="text-teal-400"
                                            >
                                                {line}
                                            </motion.div>
                                        ))}
                                        {step === 'success' && (
                                            <motion.div
                                                initial={{ opacity: 0, scale: 0.9 }}
                                                animate={{ opacity: 1, scale: 1 }}
                                                transition={{ delay: 0.2 }}
                                                className="mt-6 border border-teal-500/30 bg-teal-500/10 rounded-lg p-4 flex items-center space-x-3 text-teal-300"
                                            >
                                                <div className="bg-teal-500 text-[#020b1a] rounded-full p-1">
                                                    <Check size={16} strokeWidth={3} />
                                                </div>
                                                <div>
                                                    <p className="font-bold">SIGNAL_VERIFIED</p>
                                                    <p className="opacity-70">We will be in touch shortly.</p>
                                                    <p className="mt-1 opacity-70">REFERENCE: {submissionRefId}</p>
                                                </div>
                                            </motion.div>
                                        )}
                                    </motion.div>
                                )}
                            </div>
                        </motion.div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};

export default SignalSubmissionModal;
