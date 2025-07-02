# Batch Translation Script

A powerful translation tool using **Gemini 2.5 Pro** for the multilingual Eleventy blog that delivers superior quality for Web3 and domain-specific terminology.

## Features

- ✅ **Gemini 2.5 Pro AI**: Google's most advanced AI model for context-aware, technical translations
- ✅ **Single API Solution**: One API key handles all 7 languages with consistent high quality
- ✅ **Three Main Use Cases**: Full locale translation, selective file translation, and default EN→ALL
- ✅ **Context-Aware Translation**: Specialized prompts for blog posts, TLD pages, glossary terms, and partner content
- ✅ **Web3 Expertise**: Trained specifically for blockchain, domain, and technical terminology
- ✅ **Markdown Support**: Preserves formatting while translating content and frontmatter
- ✅ **Progress Tracking**: Visual progress bar with file-by-file status
- ✅ **Error Handling**: Continues processing on failures, provides detailed error reports
- ✅ **Dry Run Mode**: Preview translations without making changes
- ✅ **Backup Support**: Optional backup of existing files before overwriting

## Prerequisites

### Install Dependencies

```bash
npm install
```

### API Key Setup

You need a Gemini API key:

#### Gemini 2.5 Pro API (Recommended)
```bash
export GEMINI_API_KEY="your-gemini-api-key"
```

**How to get Gemini API Key:**
1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Sign in with your Google account
3. Click "Create API Key"
4. Copy the generated API key
5. Set it as an environment variable

**Why Gemini 2.5 Pro?**
- Superior context understanding for technical Web3 content
- Handles all 7 languages with consistent quality
- Better preservation of markdown formatting and technical terms
- Advanced reasoning for domain-specific terminology
- Single API simplifies setup and maintenance

## Usage

### Use Case 1: Full Locale Translation

Translate all content from one language to all others:

```bash
# Translate all English content to all supported languages
npm run translate -- --from en --to all

# Translate all German content to all other languages  
npm run translate -- --from de --to all
```

### Use Case 2: Selective File Translation

Translate specific files to one or multiple target languages:

```bash
# Translate specific files to German and French
npm run translate -- --files "src/en/blog/what-is-domain.md,src/en/glossary/nft.md" --to de,fr

# Translate all partner pages to all languages
npm run translate -- --files "src/en/partners/*.md" --to all

# Translate all glossary terms to Spanish
npm run translate -- --files "src/en/glossary/**/*.md" --to es
```

### Use Case 3: Default EN→ALL

Default behavior - translate all English content to all supported languages:

```bash
# Simple command - translates everything from English
npm run translate
```

## Advanced Options

### Content Type Filtering

Translate only specific content types:

```bash
# Only translate blog posts
npm run translate -- --content-type blog

# Translate blog posts and glossary terms
npm run translate -- --content-type blog,glossary

# All content types: blog,tld,glossary,partners
npm run translate -- --content-type blog,tld,glossary,partners
```

### Safety and Testing Options

```bash
# Dry run - preview what would be translated
npm run translate -- --dry-run

# Create backups before overwriting existing files
npm run translate -- --backup

# Force overwrite existing files (default: skip existing)
npm run translate -- --force

# Combine options
npm run translate -- --from en --to de,fr --dry-run --backup
```

## Supported Languages

All languages are powered by Gemini 2.5 Pro for consistent, high-quality translations:

- **English** (en) - Default source language
- **German** (de) - Gemini 2.5 Pro
- **Spanish** (es) - Gemini 2.5 Pro
- **French** (fr) - Gemini 2.5 Pro
- **Chinese** (zh) - Gemini 2.5 Pro (Simplified)
- **Arabic** (ar) - Gemini 2.5 Pro
- **Hindi** (hi) - Gemini 2.5 Pro

## Content Types

The script handles four main content types:

1. **Blog Posts** (`src/{lang}/blog/**/*.md`)
2. **TLD Pages** (`src/{lang}/tld/**/*.md`)
3. **Glossary Terms** (`src/{lang}/glossary/**/*.md`)
4. **Partner Pages** (`src/{lang}/partners/**/*.md`)

## Translation Process

### Frontmatter Fields Translated:
- `title` - Page/post title
- `description` - Meta description for SEO
- `keywords` - SEO keywords

### Frontmatter Fields Preserved:
- `date` - Publication date
- `language` - Updated to target language
- `tags` - Content tags
- `authors` - Author identifiers  
- `draft` - Publication status

### Content Processing:
- Full markdown content is translated
- Code blocks are preserved
- URLs and technical terms are protected
- Web3 terminology uses consistent glossary translations

## Web3 Terminology Glossary

The script includes a comprehensive glossary for consistent translation of:

- **Core Web3 Terms**: blockchain, NFT, DeFi, smart contract, dApp
- **Domain Terms**: DNS, ENS, TLD, subdomain, registrar, WHOIS
- **NameFi Terms**: domain tokenization, domain portfolio
- **Financial Terms**: liquidity, yield farming, staking
- **Technical Terms**: governance token, oracle, consensus mechanism

## Error Handling

- **Service Unavailable**: Falls back to original text if translation API fails
- **Missing API Keys**: Warns and skips unsupported language combinations
- **File Errors**: Continues processing other files, reports errors at end
- **Rate Limiting**: Built-in concurrency limits to respect API quotas

## File Organization

- `scripts/translate.mjs` - Main translation script
- `scripts/translate-config.js` - Web3 glossary and language rules
- `scripts/README.md` - This documentation

## Examples

### Complete workflow for new blog post:

1. Write new blog post in English: `src/en/blog/new-post.md`
2. Translate to all languages: `npm run translate -- --files "src/en/blog/new-post.md" --to all`
3. Review translations and build: `npm run build`

### Fill missing glossary translations:

```bash
# Check what's missing first
npm run translate -- --from en --content-type glossary --dry-run

# Translate all glossary terms to all languages
npm run translate -- --from en --content-type glossary --to all
```

### Update existing translations:

```bash
# Force overwrite existing German translations
npm run translate -- --from en --to de --force --backup
```

## Tips

1. **Always run dry-run first** to preview changes
2. **Use backups** when overwriting existing content
3. **Test with small batches** before running full translations
4. **Review generated content** - automated translation may need human refinement
5. **DeepL quality is higher** for European languages
6. **Custom terminology** in glossary ensures consistency across all content

## Troubleshooting

### No Gemini API configured
```
❌ Gemini API not configured. Please set GEMINI_API_KEY
```
**Solution**: Get your Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey) and set the environment variable.

### Files already exist
```
⚠️ Skipping src/de/blog/post.md (already exists)
```
**Solution**: Use `--force` flag to overwrite or `--backup` to create backups first.

### API quota exceeded
**Solution**: The script includes rate limiting, but you may need to wait or upgrade your API plan.

### Translation quality issues
**Solution**: Review the Web3 glossary in `translate-config.js` and add specific terms for your content.