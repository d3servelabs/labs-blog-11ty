import pLimit from 'p-limit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { TermExtractor, TermMapper } from './utils.mjs';
import { LANGUAGE_NAMES } from './config.mjs';

// Base translation service class
class TranslationService {
  constructor() {
    this.limit = pLimit(4); // Default concurrency
  }
  
  async translateText(text, targetLang, sourceLang = 'en', termConstraints = '') {
    throw new Error('translateText must be implemented by subclass');
  }
  
  async translateWithTerms(text, targetLang, sourceLang = 'en', contentType = 'general') {
    // Extract terms from content
    const terms = TermExtractor.extractGlossaryTerms(text);
    
    if (terms.length > 0) {
      console.log(`🔍 Found ${terms.length} glossary terms: ${terms.join(', ')}`);
      
      // Load term mappings
      const mappings = await TermMapper.loadTermMappings(terms, sourceLang, targetLang);
      
      // Generate constraints
      const termConstraints = TermMapper.generateTermConstraints(mappings, sourceLang, targetLang);
      
      // Report term status
      if (Object.keys(mappings.existing).length > 0) {
        console.log(`✅ ${Object.keys(mappings.existing).length} terms have existing translations`);
      }
      if (mappings.missing.length > 0) {
        console.log(`⚠️  ${mappings.missing.length} terms need translation: ${mappings.missing.map(m => m.sourceTitle).join(', ')}`);
      }
      
      return await this.translateText(text, targetLang, sourceLang, termConstraints, contentType);
    } else {
      return await this.translateText(text, targetLang, sourceLang, '', contentType);
    }
  }
  
  async translateKeywords(keywords, targetLang, sourceLang = 'en', contentType = 'general') {
    if (!keywords || targetLang === sourceLang) return keywords;
    
    // Handle both array and string formats
    let keywordArray;
    if (Array.isArray(keywords)) {
      keywordArray = keywords;
    } else if (typeof keywords === 'string') {
      keywordArray = keywords.split(',').map(k => k.trim());
    } else {
      return keywords; // Return as-is if not array or string
    }
    
    if (keywordArray.length === 0) return keywords;
    
    console.log(`🏷️ Translating ${keywordArray.length} keywords: ${keywordArray.join(', ')}`);
    
    // Join keywords into a single string for translation with special formatting
    const keywordsText = keywordArray.map(k => `"${k}"`).join(', ');
    
    try {
      const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
      const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;
      
      const prompt = `Translate the following SEO keywords from ${sourceLangName} to ${targetLangName}. 

CRITICAL REQUIREMENTS:
• Each keyword must be translated to ${targetLangName}
• Maintain SEO value and search intent in ${targetLangName}
• Keep technical terms appropriately localized (e.g. "DNS" may stay "DNS" but "domain name" should be translated)
• Preserve keyword format as individual terms
• Return ONLY the translated keywords in the same quoted format

Content context: ${contentType}

Keywords to translate: ${keywordsText}

Expected output format: "translated keyword 1", "translated keyword 2", etc.`;

      const translatedText = await this.translateText(prompt, targetLang, sourceLang, '', 'keywords');
      
      // Parse the translated result back into array
      const translatedKeywords = translatedText
        .split(',')
        .map(k => k.trim().replace(/^["']|["']$/g, '')) // Remove quotes
        .filter(k => k.length > 0);
      
      if (translatedKeywords.length > 0) {
        console.log(`✅ Keywords translated: ${translatedKeywords.join(', ')}`);
        return translatedKeywords;
      } else {
        console.warn(`⚠️ Keywords translation failed, keeping original`);
        return keywordArray;
      }
    } catch (error) {
      console.error(`❌ Keywords translation error: ${error.message}`);
      return keywordArray; // Return original on error
    }
  }
}

// Gemini translation service
class GeminiTranslationService extends TranslationService {
  constructor(model = 'gemini-2.5-flash') {
    super();
    this.modelName = model;
    this.limit = pLimit(model === 'gemini-2.5-flash' ? 6 : 2);
    this.genAI = null;
    this.model = null;
    
    if (process.env.GEMINI_API_KEY) {
      this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      this.model = this.genAI.getGenerativeModel({ model: this.modelName });
    }
  }

  async translateText(text, targetLang, sourceLang = 'en', termConstraints = '', contentType = 'general') {
    if (!text || typeof text !== 'string' || text.trim() === '') return text;
    if (targetLang === sourceLang) return text;
    
    return this.limit(async () => {
      try {
        if (!this.model) {
          console.warn(`No Gemini API configured, returning original text`);
          return text;
        }

        const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
        const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;

        // Context-specific prompts
        const contextPrompts = {
          blog: "This is content from a Web3/blockchain blog post about domain names and tokenization.",
          tld: "This is technical content about top-level domains (TLD) and domain extensions.",
          glossary: "This is a definition from a Web3/blockchain glossary explaining technical terms.",
          partners: "This is content about business partnerships in the Web3/domain space."
        };

        const contextInfo = contextPrompts[contentType] || "This is Web3/blockchain related content.";

        const prompt = `Please translate the following technical content from ${sourceLangName} into ${targetLangName}, with the goal of producing a natural, fluent, and high-quality technical blog post.

Requirements:

• Preserve the original meaning, but feel free to restructure for better flow in ${targetLangName}.
• Use the natural tone and style of technical blog posts in ${targetLangName}—avoid overly literal or robotic translation.
• Keep the tone clear, confident, and easy to read for developers.
• Avoid repetitive phrasing or generic AI-style introductions like "This article will show you…" unless it fits the local convention.
• Do not translate terms that are better left in English (e.g., function names, code keywords, common tech acronyms).
• Preserve all markdown formatting, HTML tags, and structure exactly.
• Keep code blocks, URLs, domain names, and file extensions unchanged.
• Brand names (Namefi, Ethereum, etc.) should remain unchanged.
• Translate keywords, tags, and topic sections to ${targetLangName} where appropriate for SEO and discoverability.
• ${contextInfo}${termConstraints}

【Content starts】

${text}

【Content ends】

Response format: Provide ONLY the translated text with preserved formatting.`;

        const result = await this.model.generateContent(prompt);
        const response = await result.response;
        const translatedText = response.text().trim();
        
        return translatedText;
      } catch (error) {
        console.error(`Gemini translation error for ${targetLang}:`, error.message);
        return text; // Return original text on error
      }
    });
  }
}

// OpenAI translation service
class OpenAITranslationService extends TranslationService {
  constructor(model = 'gpt-4o-mini') {
    super();
    this.modelName = model;
    this.limit = pLimit(8); // OpenAI can handle higher concurrency
    this.client = null;
    
    if (process.env.OPENAI_API_KEY) {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
  }

  async translateText(text, targetLang, sourceLang = 'en', termConstraints = '', contentType = 'general') {
    if (!text || typeof text !== 'string' || text.trim() === '') return text;
    if (targetLang === sourceLang) return text;
    
    return this.limit(async () => {
      try {
        if (!this.client) {
          console.warn(`No OpenAI API configured, returning original text`);
          return text;
        }

        const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
        const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;

        // Context-specific prompts
        const contextPrompts = {
          blog: "This is content from a Web3/blockchain blog post about domain names and tokenization.",
          tld: "This is technical content about top-level domains (TLD) and domain extensions.",
          glossary: "This is a definition from a Web3/blockchain glossary explaining technical terms.",
          partners: "This is content about business partnerships in the Web3/domain space."
        };

        const contextInfo = contextPrompts[contentType] || "This is Web3/blockchain related content.";

        const prompt = `Please translate the following technical content from ${sourceLangName} into ${targetLangName}, with the goal of producing a natural, fluent, and high-quality technical blog post.

Requirements:

• Preserve the original meaning, but feel free to restructure for better flow in ${targetLangName}.
• Use the natural tone and style of technical blog posts in ${targetLangName}—avoid overly literal or robotic translation.
• Keep the tone clear, confident, and easy to read for developers.
• Avoid repetitive phrasing or generic AI-style introductions like "This article will show you…" unless it fits the local convention.
• Do not translate terms that are better left in English (e.g., function names, code keywords, common tech acronyms).
• Preserve all markdown formatting, HTML tags, and structure exactly.
• Keep code blocks, URLs, domain names, and file extensions unchanged.
• Brand names (Namefi, Ethereum, etc.) should remain unchanged.
• Translate keywords, tags, and topic sections to ${targetLangName} where appropriate for SEO and discoverability.
• ${contextInfo}${termConstraints}

【Content starts】

${text}

【Content ends】

Response format: Provide ONLY the translated text with preserved formatting.`;

        const completion = await this.client.chat.completions.create({
          model: this.modelName,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.3
        });
        
        return completion.choices[0].message.content.trim();
      } catch (error) {
        console.error(`OpenAI translation error for ${targetLang}:`, error.message);
        return text; // Return original text on error
      }
    });
  }
}

// Service factory
class TranslationServiceFactory {
  static createService(service = 'gemini', model = null) {
    switch (service.toLowerCase()) {
      case 'openai':
        return new OpenAITranslationService(model || 'gpt-4o-mini');
      case 'gemini':
      default:
        return new GeminiTranslationService(model || 'gemini-2.5-flash');
    }
  }
}

export { 
  TranslationService, 
  GeminiTranslationService, 
  OpenAITranslationService, 
  TranslationServiceFactory 
};