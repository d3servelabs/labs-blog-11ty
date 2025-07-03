#!/usr/bin/env node

import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';
import { Command } from 'commander';

// Standard YAML schema for all content types
const REQUIRED_FIELDS = {
  blog: ['title', 'date', 'language', 'tags', 'authors', 'draft', 'description', 'keywords'],
  tld: ['title', 'date', 'language', 'tags', 'authors', 'draft', 'description'],
  glossary: ['title', 'date', 'language', 'tags', 'authors', 'draft', 'description'],
  partners: ['title', 'date', 'language', 'tags', 'authors', 'draft', 'description']
};

const OPTIONAL_FIELDS = ['keywords', 'image', 'canonical', 'featured'];

// Field type definitions
const FIELD_TYPES = {
  title: 'string',
  date: 'string',
  language: 'string', 
  tags: 'array',
  authors: 'array',
  draft: 'boolean',
  description: 'string',
  keywords: 'array',
  image: 'string',
  canonical: 'string',
  featured: 'boolean'
};

// Default values for missing fields
const DEFAULT_VALUES = {
  tags: ['general'],
  authors: ['namefiteam'],
  draft: false,
  keywords: []
};

class YAMLLinter {
  constructor(options = {}) {
    this.dryRun = options.dryRun || false;
    this.fix = options.fix || false;
    this.verbose = options.verbose || false;
    this.errors = [];
    this.warnings = [];
    this.fixed = [];
  }

  async lintFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const { data: frontMatter, content: markdownBody } = matter(content);
      
      const contentType = this.getContentType(filePath);
      const issues = this.validateFrontMatter(frontMatter, contentType, filePath);
      
      if (this.fix && issues.fixable.length > 0) {
        const fixedFrontMatter = this.applyFixes(frontMatter, issues.fixable);
        const newContent = matter.stringify(markdownBody, fixedFrontMatter);
        
        if (!this.dryRun) {
          await fs.writeFile(filePath, newContent, 'utf8');
          this.fixed.push({
            file: filePath,
            fixes: issues.fixable.map(f => f.message)
          });
        } else {
          console.log(`[DRY RUN] Would fix: ${filePath}`);
          issues.fixable.forEach(fix => {
            console.log(`  • ${fix.message}`);
          });
        }
      }

      return {
        file: filePath,
        errors: issues.errors,
        warnings: issues.warnings,
        fixable: issues.fixable
      };
    } catch (error) {
      this.errors.push({
        file: filePath,
        message: `Failed to process file: ${error.message}`
      });
      return null;
    }
  }

  getContentType(filePath) {
    if (filePath.includes('/blog/')) return 'blog';
    if (filePath.includes('/tld/')) return 'tld';
    if (filePath.includes('/glossary/')) return 'glossary';
    if (filePath.includes('/partners/')) return 'partners';
    return 'blog'; // default
  }

  validateFrontMatter(frontMatter, contentType, filePath) {
    const errors = [];
    const warnings = [];
    const fixable = [];

    const requiredFields = REQUIRED_FIELDS[contentType] || REQUIRED_FIELDS.blog;

    // Check required fields
    for (const field of requiredFields) {
      if (!frontMatter.hasOwnProperty(field)) {
        if (DEFAULT_VALUES[field] !== undefined) {
          fixable.push({
            type: 'add_field',
            field,
            value: DEFAULT_VALUES[field],
            message: `Add missing required field '${field}' with default value`
          });
        } else {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Check field types and formats
    for (const [field, value] of Object.entries(frontMatter)) {
      if (FIELD_TYPES[field]) {
        const expectedType = FIELD_TYPES[field];
        const actualType = this.getValueType(value);

        if (expectedType !== actualType) {
          // Special handling for fixable type mismatches
          if (field === 'keywords' && expectedType === 'array') {
            if (typeof value === 'string') {
              // Convert comma-separated string to array
              fixable.push({
                type: 'fix_type',
                field,
                value: value.split(',').map(k => k.trim()),
                message: `Convert keywords from string to array format`
              });
            } else {
              errors.push(`Field '${field}' should be ${expectedType}, got ${actualType}`);
            }
          } else if ((field === 'tags' || field === 'authors') && expectedType === 'array' && actualType === 'string') {
            fixable.push({
              type: 'fix_type',
              field,
              value: [value],
              message: `Convert ${field} from string to array format`
            });
          } else {
            errors.push(`Field '${field}' should be ${expectedType}, got ${actualType}`);
          }
        }
      }
    }

    // Special validation for keywords field
    if (frontMatter.keywords) {
      if (Array.isArray(frontMatter.keywords)) {
        // Check if all keywords are strings
        const nonStringKeywords = frontMatter.keywords.filter(k => typeof k !== 'string');
        if (nonStringKeywords.length > 0) {
          errors.push(`All keywords must be strings, found non-strings: ${nonStringKeywords}`);
        }
        
        // Check for empty keywords
        const emptyKeywords = frontMatter.keywords.filter(k => !k || k.trim() === '');
        if (emptyKeywords.length > 0) {
          fixable.push({
            type: 'clean_keywords',
            field: 'keywords',
            value: frontMatter.keywords.filter(k => k && k.trim() !== ''),
            message: `Remove empty keywords`
          });
        }
      }
    } else if (contentType === 'blog') {
      warnings.push(`Blog posts should have keywords for SEO`);
    }

    // Language-specific validation
    const language = frontMatter.language;
    if (language) {
      const expectedLang = this.extractLanguageFromPath(filePath);
      if (language !== expectedLang) {
        fixable.push({
          type: 'fix_language',
          field: 'language',
          value: expectedLang,
          message: `Fix language field to match file path (expected ${expectedLang}, got ${language})`
        });
      }
    }

    return { errors, warnings, fixable };
  }

  applyFixes(frontMatter, fixes) {
    const fixed = { ...frontMatter };

    for (const fix of fixes) {
      switch (fix.type) {
        case 'add_field':
        case 'fix_type':
        case 'fix_language':
        case 'clean_keywords':
          fixed[fix.field] = fix.value;
          break;
      }
    }

    return fixed;
  }

  getValueType(value) {
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    return 'unknown';
  }

  extractLanguageFromPath(filePath) {
    // Extract language from path like: src/en/blog/post.md -> en
    const match = filePath.match(/\/src\/([a-z]{2})\//);
    return match ? match[1] : 'en';
  }

  async discoverFiles(patterns) {
    const allFiles = [];
    for (const pattern of patterns) {
      const files = await glob(pattern, {
        cwd: process.cwd(),
        ignore: ['**/node_modules/**', '**/dist/**']
      });
      allFiles.push(...files);
    }
    return allFiles;
  }

  printSummary(results) {
    const totalFiles = results.length;
    const filesWithErrors = results.filter(r => r && r.errors.length > 0).length;
    const filesWithWarnings = results.filter(r => r && r.warnings.length > 0).length;
    const filesWithFixes = this.fixed.length;

    console.log('\n📊 YAML Linting Summary:');
    console.log(`   Total files checked: ${totalFiles}`);
    console.log(`   Files with errors: ${filesWithErrors}`);
    console.log(`   Files with warnings: ${filesWithWarnings}`);
    if (this.fix) {
      console.log(`   Files fixed: ${filesWithFixes}`);
    }

    // Print errors
    if (filesWithErrors > 0) {
      console.log('\n❌ Errors found:');
      results.forEach(result => {
        if (result && result.errors.length > 0) {
          console.log(`\n${result.file}:`);
          result.errors.forEach(error => {
            console.log(`  • ${error}`);
          });
        }
      });
    }

    // Print warnings
    if (filesWithWarnings > 0 && this.verbose) {
      console.log('\n⚠️  Warnings:');
      results.forEach(result => {
        if (result && result.warnings.length > 0) {
          console.log(`\n${result.file}:`);
          result.warnings.forEach(warning => {
            console.log(`  • ${warning}`);
          });
        }
      });
    }

    // Print fixes
    if (filesWithFixes > 0) {
      console.log('\n✅ Fixed issues:');
      this.fixed.forEach(fix => {
        console.log(`\n${fix.file}:`);
        fix.fixes.forEach(fixMsg => {
          console.log(`  • ${fixMsg}`);
        });
      });
    }

    return filesWithErrors === 0;
  }
}

// CLI setup
const program = new Command();

program
  .name('lint-yaml')
  .description('Lint and fix YAML frontmatter in Markdown files')
  .version('1.0.0');

program
  .option('--fix', 'Automatically fix issues where possible')
  .option('--dry-run', 'Show what would be fixed without making changes (implies --fix)')
  .option('--verbose', 'Show warnings in addition to errors')
  .option('--files <patterns>', 'Specific file patterns (comma-separated)')
  .option('--content-type <types>', 'Content types to check (comma-separated): blog,tld,glossary,partners')
  .action(async (options) => {
    console.log('🔍 YAML Frontmatter Linter Starting...\n');

    const linter = new YAMLLinter({
      dryRun: options.dryRun,
      fix: options.fix || options.dryRun,
      verbose: options.verbose
    });

    // Determine files to check
    let patterns = [];
    
    if (options.files) {
      patterns = options.files.split(',').map(p => p.trim());
    } else {
      const contentTypes = options.contentType ? 
        options.contentType.split(',').map(t => t.trim()) : 
        ['blog', 'tld', 'glossary', 'partners'];
      
      // Check all languages
      const languages = ['en', 'ar', 'de', 'es', 'fr', 'hi', 'zh'];
      
      for (const lang of languages) {
        for (const type of contentTypes) {
          patterns.push(`src/${lang}/${type}/**/*.md`);
        }
      }
    }

    const files = await linter.discoverFiles(patterns);
    
    if (files.length === 0) {
      console.log('❌ No markdown files found to check');
      return;
    }

    console.log(`📁 Found ${files.length} files to check\n`);

    // Process files
    const results = [];
    for (const file of files) {
      const result = await linter.lintFile(file);
      if (result) {
        results.push(result);
        
        // Show immediate feedback for errors
        if (result.errors.length > 0 && !linter.fix) {
          console.log(`❌ ${file}: ${result.errors.length} error(s)`);
        } else if (result.fixable.length > 0 && linter.fix) {
          console.log(`🔧 ${file}: ${result.fixable.length} issue(s) ${linter.dryRun ? 'would be ' : ''}fixed`);
        } else {
          console.log(`✅ ${file}: OK`);
        }
      }
    }

    // Print summary
    const success = linter.printSummary(results);
    
    if (!success) {
      console.log('\n💡 Run with --fix to automatically fix issues where possible');
      process.exit(1);
    } else {
      console.log('\n🎉 All files passed YAML linting!');
    }
  });

program.parse(process.argv);