import { createHash } from 'node:crypto';
import { relevanceProfiles, relevanceQueries } from './semantic-relevance.js';

// Human-written synthetic Spanish counterparts; no model generates its own
// relevance labels. Job/region/pay details occur exclusively in reviewed CVs.
const spanish = {
  solidity: 'Desarrolla protocolos de préstamos, contratos de staking y creadores de mercado automatizados en Ethereum. Programa contratos Solidity en producción, escribe pruebas con Foundry y optimiza el consumo de gas.',
  audit: 'Audita contratos EVM existentes para detectar reentrancia, fallos de control de acceso y ataques económicos. Entrega informes de seguridad y pruebas mediante fuzzing. Prefiere proyectos de revisión de seguridad.',
  rust: 'Desarrolla infraestructura de negociación de baja latencia y servicios de red concurrentes en Rust. Analiza la asignación de memoria, optimiza la ejecución y mantiene conexiones con mercados financieros.',
  python: 'Construye servicios Django y FastAPI con PostgreSQL. Diseña APIs REST, migraciones de bases de datos y tareas en segundo plano para aplicaciones empresariales.',
  typescript: 'Construye servicios Node.js con NestJS y TypeScript. Diseña APIs orientadas a eventos, consumidores de colas e integraciones para productos de suscripción.',
  frontend: 'Desarrolla interfaces web accesibles con React y TypeScript. Implementa sistemas de diseño, navegación mediante teclado y pantallas adaptables; reduce los tiempos de renderizado.',
  design: 'Realiza entrevistas y estudios de usabilidad. Crea prototipos en Figma y diseños de interacción, y prueba los flujos del producto con clientes. No implementa código de producción.',
  data: 'Construye pipelines de datos por lotes y en tiempo real con Spark, Airflow y Kafka. Mantiene transformaciones del almacén de datos, controles de calidad e ingesta fiable.',
  analytics: 'Utiliza SQL y Python para investigar activación, conversión y retención. Diseña experimentos A/B, explica métricas de negocio y construye paneles para apoyar decisiones.',
  recommendation: 'Entrena y despliega modelos de recomendación y clasificación a partir de interacciones entre usuarios y artículos. Trabaja en recuperación, personalización, evaluación e inferencia.',
  vision: 'Entrena modelos de detección de objetos y segmentación de imágenes para inspección industrial. Prepara imágenes anotadas y despliega redes neuronales en dispositivos locales.',
  sre: 'Opera servicios Kubernetes y automatiza la respuesta a incidentes. Desarrolla observabilidad, objetivos de nivel de servicio e infraestructura con Terraform para mejorar la disponibilidad.',
  ios: 'Construye aplicaciones nativas para iPhone con Swift y SwiftUI. Implementa sincronización sin conexión, accesibilidad y publicaciones en la App Store.',
  android: 'Construye aplicaciones nativas Android con Kotlin y Jetpack Compose. Gestiona tareas en segundo plano, compatibilidad entre dispositivos y publicaciones en Google Play.',
  qa: 'Construye pruebas de navegador y API con Playwright. Investiga pruebas inestables, diseña cobertura de regresión e integra las pruebas en la entrega continua.',
  recruiter: 'Busca y entrevista ingenieros Solidity, Rust y Python. Gestiona procesos de selección, negocia ofertas y colabora con responsables de contratación. No desarrolla software.',
  sales: 'Vende software B2B a grandes empresas. Realiza reuniones de descubrimiento, negocia contratos anuales y gestiona ciclos de venta complejos con departamentos de compras.',
  success: 'Incorpora cuentas empresariales existentes, supervisa la adopción y gestiona riesgos de renovación. Coordina incidencias de soporte y elabora planes de éxito del cliente.',
  finance: 'Dirige el cierre contable mensual, los estados financieros y la planificación de tesorería. Concilia cuentas, coordina auditorías e implementa controles contables.',
  product: 'Define prioridades de producto según las necesidades de clientes y los objetivos empresariales. Redacta requisitos, coordina ingeniería y diseño y mide los resultados de las funcionalidades.',
};
const contextSpanish = [
  'Madrid. Trabajo remoto desde Europa; salario anual de 90 a 110 mil euros.',
  'Londres. Modalidad híbrida dos días por semana; salario anual de 85 a 100 mil libras.',
  'Berlín. Trabajo remoto o híbrido; salario anual de 100 a 120 mil euros.',
  'Barcelona. Solo trabajo remoto; incorporación tras dos meses de preaviso.',
  'Lisboa. Disponible para empleo permanente o un contrato de seis meses.',
];
const filler = [
  'Working practices. At the beginning of each assignment, I agree the intended outcome and write down the questions that need clarification. I keep a concise record of decisions and explain changes to colleagues before handing work over.',
  'Collaboration. I have worked with colleagues in different time zones. Written notes allow people who missed a meeting to understand the discussion. I ask for feedback early and make room for others to explain their reasoning.',
  'Learning and development. I reserve time for reading, practice and reflection. When an approach is unfamiliar, I break the problem into smaller questions and document what I learned so that another person can repeat the process.',
  'Professional conduct. I respect confidential information and use the agreed channels when sharing material. I clarify ownership, expected dates and handover arrangements before accepting a new responsibility.',
  'References and further details. Additional examples can be discussed during an interview. References are available with prior agreement. This synthetic résumé describes working habits and contains no real person’s employment history.',
  'Hábitos de trabajo. Mantengo apuntes claros, escucho las observaciones de mis compañeros y reviso los compromisos acordados. Aprendizaje continuo, comunicación respetuosa y colaboración internacional. 中文 résumé café 👩🏽‍💻.',
];
const hash = text => createHash('sha256').update(text).digest('hex');

export const cvRelevanceProfiles = relevanceProfiles.map((profile, index) => {
  const variant = index % 5, language = variant >= 3 ? 'es' : 'en';
  const passage = language === 'es'
    ? `Experiencia profesional. ${spanish[profile.discipline]}\nPreferencias. ${contextSpanish[variant]}`
    : `Professional experience. ${profile.fields.professionalSummary}\nLocation: ${profile.fields.location}. Preferences: ${profile.fields.compensationPreference}`;
  const nearLimit = index === 4;
  const paragraphs = Array.from({ length: 12 + variant * 3 }, (_, i) => filler[i % filler.length]);
  if (nearLimit) while (Buffer.byteLength([...paragraphs, filler[paragraphs.length % filler.length], passage].join('\n\n')) <= 65000) paragraphs.push(filler[paragraphs.length % filler.length]);
  const position = variant === 0 ? 'beginning' : [1, 3].includes(variant) ? 'middle' : 'end';
  paragraphs.splice(position === 'beginning' ? 0 : position === 'middle' ? Math.floor(paragraphs.length / 2) : paragraphs.length, 0, passage);
  const text = paragraphs.join('\n\n');
  return { key: profile.key, discipline: profile.discipline, language, position, nearLimit, text, passage,
    fields: { firstName: 'Synthetic', lastName: `Person${index + 1}`, primaryEmail: `person${index + 1}@example.invalid` },
    blocks: paragraphs.map((text, ordinal) => ({ ordinal, kind: 'docx_paragraph', part: 'word/document.xml', paragraph: ordinal + 1, text, sha256: hash(text) })) };
});
export const cvRelevanceQueries = relevanceQueries;
