/**
 * Translation configuration for Web3 and domain terminology
 * Used for consistent translation across all content
 */

export const WEB3_GLOSSARY = {
  // Core Web3 Terms
  'blockchain': {
    de: 'Blockchain',
    es: 'blockchain',
    fr: 'blockchain', 
    ar: 'البلوك تشين',
    hi: 'ब्लॉकचेन',
    zh: '区块链'
  },
  'smart contract': {
    de: 'Smart Contract',
    es: 'contrato inteligente',
    fr: 'contrat intelligent',
    ar: 'العقد الذكي',
    hi: 'स्मार्ट कॉन्ट्रैक्ट',
    zh: '智能合约'
  },
  'NFT': {
    de: 'NFT',
    es: 'NFT',
    fr: 'NFT',
    ar: 'الرمز غير القابل للاستبدال',
    hi: 'एनएफटी',
    zh: '非同质化代币'
  },
  'DeFi': {
    de: 'DeFi',
    es: 'DeFi',
    fr: 'DeFi',
    ar: 'التمويل اللامركزي',
    hi: 'डीफाई',
    zh: '去中心化金融'
  },
  'cryptocurrency': {
    de: 'Kryptowährung',
    es: 'criptomoneda',
    fr: 'cryptomonnaie',
    ar: 'العملة المشفرة',
    hi: 'क्रिप्टोकरेंसी',
    zh: '加密货币'
  },
  'Web3': {
    de: 'Web3',
    es: 'Web3',
    fr: 'Web3',
    ar: 'الويب ٣',
    hi: 'वेब3',
    zh: 'Web3'
  },
  'dApp': {
    de: 'dApp',
    es: 'dApp',
    fr: 'dApp',
    ar: 'التطبيق اللامركزي',
    hi: 'डीऐप',
    zh: '去中心化应用'
  },
  
  // Domain-Specific Terms
  'domain name': {
    de: 'Domain-Name',
    es: 'nombre de dominio',
    fr: 'nom de domaine',
    ar: 'اسم النطاق',
    hi: 'डोमेन नाम',
    zh: '域名'
  },
  'DNS': {
    de: 'DNS',
    es: 'DNS',
    fr: 'DNS',
    ar: 'نظام أسماء النطاقات',
    hi: 'डीएनएस',
    zh: 'DNS'
  },
  'ENS': {
    de: 'ENS',
    es: 'ENS',
    fr: 'ENS',
    ar: 'خدمة أسماء إيثيريوم',
    hi: 'ईएनएस',
    zh: '以太坊域名服务'
  },
  'subdomain': {
    de: 'Subdomain',
    es: 'subdominio',
    fr: 'sous-domaine',
    ar: 'النطاق الفرعي',
    hi: 'सबडोमेन',
    zh: '子域名'
  },
  'TLD': {
    de: 'TLD',
    es: 'TLD',
    fr: 'TLD',
    ar: 'نطاق المستوى الأعلى',
    hi: 'टीएलडी',
    zh: '顶级域名'
  },
  'registrar': {
    de: 'Registrar',
    es: 'registrador',
    fr: 'registraire',
    ar: 'مسجل النطاقات',
    hi: 'रजिस्ट्रार',
    zh: '注册商'
  },
  'WHOIS': {
    de: 'WHOIS',
    es: 'WHOIS',
    fr: 'WHOIS',
    ar: 'معلومات من',
    hi: 'व्हॉइज़',
    zh: 'WHOIS'
  },
  
  // NameFi-Specific Terms
  'NameFi': {
    de: 'NameFi',
    es: 'NameFi',
    fr: 'NameFi',
    ar: 'نيم فاي',
    hi: 'नेमफाई',
    zh: 'NameFi'
  },
  'domain tokenization': {
    de: 'Domain-Tokenisierung',
    es: 'tokenización de dominios',
    fr: 'tokenisation de domaines',
    ar: 'ترميز النطاقات',
    hi: 'डोमेन टोकनाइज़ेशन',
    zh: '域名代币化'
  },
  'domain portfolio': {
    de: 'Domain-Portfolio',
    es: 'cartera de dominios',
    fr: 'portefeuille de domaines',
    ar: 'محفظة النطاقات',
    hi: 'डोमेन पोर्टफोलियो',
    zh: '域名组合'
  },
  
  // Financial Terms
  'liquidity': {
    de: 'Liquidität',
    es: 'liquidez',
    fr: 'liquidité',
    ar: 'السيولة',
    hi: 'तरलता',
    zh: '流动性'
  },
  'yield farming': {
    de: 'Yield Farming',
    es: 'yield farming',
    fr: 'yield farming',
    ar: 'زراعة العائد',
    hi: 'यील्ड फार्मिंग',
    zh: '流动性挖矿'
  },
  'staking': {
    de: 'Staking',
    es: 'staking',
    fr: 'mise en jeu',
    ar: 'التخزين',
    hi: 'स्टेकिंग',
    zh: '质押'
  },
  
  // Technical Terms
  'governance token': {
    de: 'Governance-Token',
    es: 'token de gobernanza',
    fr: 'jeton de gouvernance',
    ar: 'رمز الحوكمة',
    hi: 'गवर्नेंस टोकन',
    zh: '治理代币'
  },
  'oracle': {
    de: 'Oracle',
    es: 'oráculo',
    fr: 'oracle',
    ar: 'العرافة',
    hi: 'ओरेकल',
    zh: '预言机'
  },
  'consensus mechanism': {
    de: 'Konsensmechanismus',
    es: 'mecanismo de consenso',
    fr: 'mécanisme de consensus',
    ar: 'آلية الإجماع',
    hi: 'सहमति तंत्र',
    zh: '共识机制'
  }
};

/**
 * Language-specific formatting rules
 */
export const LANGUAGE_RULES = {
  ar: {
    direction: 'rtl',
    numerals: 'arabic-indic', // Use Arabic-Indic numerals
    dateFormat: 'dd/mm/yyyy'
  },
  hi: {
    direction: 'ltr',
    numerals: 'devanagari',
    dateFormat: 'dd/mm/yyyy'
  },
  zh: {
    direction: 'ltr',
    numerals: 'simplified',
    dateFormat: 'yyyy/mm/dd'
  },
  en: {
    direction: 'ltr',
    numerals: 'latin',
    dateFormat: 'mm/dd/yyyy'
  },
  de: {
    direction: 'ltr',
    numerals: 'latin',
    dateFormat: 'dd.mm.yyyy'
  },
  es: {
    direction: 'ltr',
    numerals: 'latin',
    dateFormat: 'dd/mm/yyyy'
  },
  fr: {
    direction: 'ltr',
    numerals: 'latin',
    dateFormat: 'dd/mm/yyyy'
  }
};

/**
 * Content that should NOT be translated
 */
export const PRESERVE_CONTENT = [
  // Code blocks
  /```[\s\S]*?```/g,
  // Inline code
  /`[^`]+`/g,
  // URLs
  /https?:\/\/[^\s]+/g,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // Domain names (when standalone)
  /\b[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
  // File extensions
  /\.[a-zA-Z0-9]+$/g
];

/**
 * Special handling for different content types
 */
export const CONTENT_TYPE_RULES = {
  blog: {
    translateTitle: true,
    translateDescription: true,
    translateKeywords: true,
    preserveCodeBlocks: true,
    preserveUrls: true
  },
  tld: {
    translateTitle: true,
    translateDescription: true,
    translateKeywords: false, // TLD pages have technical keywords
    preserveCodeBlocks: true,
    preserveUrls: true,
    preserveTechnicalTerms: true
  },
  glossary: {
    translateTitle: true,
    translateDescription: true,
    translateKeywords: true,
    preserveCodeBlocks: true,
    preserveUrls: true,
    useGlossary: true // Apply glossary terms consistently
  },
  partners: {
    translateTitle: true,
    translateDescription: true,
    translateKeywords: true,
    preserveCodeBlocks: true,
    preserveUrls: true,
    preserveCompanyNames: true
  }
};

export default {
  WEB3_GLOSSARY,
  LANGUAGE_RULES,
  PRESERVE_CONTENT,
  CONTENT_TYPE_RULES
};