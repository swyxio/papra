type TemplateDescription = { title: string; description: string; variant?: string };

const descriptions: Record<string, TemplateDescription> = {
  'blank': {
    title: 'Blank document',
    description: 'Start with a clean page and write your own document.',
  },
  'invoice': {
    title: 'Invoice',
    description: 'Itemize services or products, totals, and payment details.',
  },
  'agreement': {
    title: 'Agreement outline',
    description: 'Start an agreement with sections for scope, terms, and signatures.',
  },
  'mutual-nda': {
    title: 'Mutual NDA',
    description: 'Share confidential information while both sides agree to keep it private.',
  },
  'offer-letter': {
    title: 'Offer letter',
    description: 'Lay out a new hire’s role, compensation, and proposed start date.',
  },
  'employee-assignment-ca': {
    title: 'Employee invention assignment',
    description: 'Set confidentiality terms and clarify ownership of work created by an employee.',
    variant: 'California',
  },
  'consultant-assignment-individual': {
    title: 'Consultant invention assignment',
    description: 'Set confidentiality terms and clarify ownership of work created by a consultant.',
    variant: 'Individual',
  },
  'consultant-assignment-company': {
    title: 'Consultant invention assignment',
    description: 'Set confidentiality terms and clarify ownership of work created by a consultant.',
    variant: 'Company',
  },
  'advisor-agreement': {
    title: 'Advisor agreement',
    description: 'Define an advisor’s responsibilities, compensation, and engagement terms.',
  },
  'consulting-individual': {
    title: 'Consulting agreement',
    description: 'Describe a consultant’s services, payment, expenses, and termination terms.',
    variant: 'Individual',
  },
  'consulting-company': {
    title: 'Consulting agreement',
    description: 'Describe a consultant’s services, payment, expenses, and termination terms.',
    variant: 'Company',
  },
  'bylaw-certification': {
    title: 'Bylaw certification',
    description: 'Record and certify the adoption of the company’s bylaws.',
  },
};

export function describeTemplate(id: string, name: string): TemplateDescription {
  return (
    descriptions[id.replace(/^atlas:/, '')] ?? {
      title: name,
      description: 'Customize this template, then review the full document in the editor.',
    }
  );
}
