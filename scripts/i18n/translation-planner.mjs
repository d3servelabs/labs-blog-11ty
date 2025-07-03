import { TokenEstimator } from './utils.mjs';
import { SCRIPT_VERSION } from './config.mjs';
import {
  shouldRegenerate,
  getDependenciesHash
} from '../cache-utils.mjs';

// Translation planning utilities
export class TranslationPlanner {
  constructor(fileProcessor) {
    this.fileProcessor = fileProcessor;
  }
  
  async analyzePendingWork(sourceFiles, targetLangs, sourceLang = 'en', skipCache = false) {
    const startTime = Date.now();
    console.log(`📋 Analyzing cache status for ${sourceFiles.length} files × ${targetLangs.length} languages...`);
    
    const pendingTasks = [];
    const skippedTasks = [];
    
    // Group by content type for analysis
    const byContentType = {
      blog: [],
      tld: [],
      glossary: [],
      partners: [],
      general: []
    };
    
    for (const sourceFile of sourceFiles) {
      const contentType = TokenEstimator.getContentTypeFromPath(sourceFile);
      
      for (const targetLang of targetLangs) {
        const task = {
          sourceFile,
          targetLang,
          sourceLang,
          contentType,
          targetPath: this.fileProcessor.generateTargetPath(sourceFile, targetLang, sourceLang)
        };
        
        // Check if translation is needed
        const isNeeded = await this.isTranslationNeeded(sourceFile, targetLang, sourceLang, skipCache);
        
        if (isNeeded) {
          pendingTasks.push(task);
          byContentType[contentType].push(task);
        } else {
          skippedTasks.push(task);
        }
      }
    }
    
    // Estimate actual tokens for pending source files
    console.log(`🔢 Estimating tokens for ${pendingTasks.length} pending translations...`);
    const uniqueSourceFiles = [...new Set(pendingTasks.map(t => t.sourceFile))];
    const tokenEstimates = await TokenEstimator.estimateTokensFromFiles(uniqueSourceFiles);
    
    // Add token estimates to tasks
    pendingTasks.forEach(task => {
      task.estimatedTokens = tokenEstimates[task.sourceFile] || TokenEstimator.getExpectedTokens(task.contentType);
    });
    
    const elapsed = Date.now() - startTime;
    
    // Generate analysis report with actual token estimates
    const analysis = {
      pending: pendingTasks,
      skipped: skippedTasks,
      byContentType,
      tokenEstimates,
      summary: {
        totalPossible: sourceFiles.length * targetLangs.length,
        pending: pendingTasks.length,
        skipped: skippedTasks.length,
        byType: Object.entries(byContentType).map(([type, tasks]) => {
          const actualTokens = tasks.reduce((sum, task) => {
            return sum + (tokenEstimates[task.sourceFile] || TokenEstimator.getExpectedTokens(type));
          }, 0);
          return {
            type,
            count: tasks.length,
            estimatedTokens: actualTokens,
            avgTokensPerFile: tasks.length > 0 ? Math.round(actualTokens / tasks.length) : 0
          };
        })
      },
      elapsed
    };
    
    this.printAnalysisReport(analysis);
    return analysis;
  }
  
  async isTranslationNeeded(filePath, targetLang, sourceLang, skipCache) {
    if (skipCache) return true;
    
    // Quick file existence check
    const targetPath = this.fileProcessor.generateTargetPath(filePath, targetLang, sourceLang);
    const targetExists = await this.fileProcessor.fileExists(targetPath);
    
    if (!targetExists) return true;
    
    // Deep cache validation
    const promptHash = this.fileProcessor.getTranslationPromptHash(sourceLang, targetLang);
    const dependenciesHash = getDependenciesHash([], `${SCRIPT_VERSION}-${promptHash}`);
    
    return shouldRegenerate(filePath, 'translations', dependenciesHash);
  }
  
  printAnalysisReport(analysis) {
    console.log(`✅ Cache analysis complete [${analysis.elapsed}ms]`);
    console.log(`📊 Translation Status:`);
    console.log(`   Total: ${analysis.summary.totalPossible} possible translations`);
    console.log(`   Pending: ${analysis.summary.pending} translations needed`);
    console.log(`   Cached: ${analysis.summary.skipped} already completed\n`);
    
    if (analysis.summary.pending > 0) {
      console.log(`📦 Pending Work by Content Type (actual file sizes):`);
      analysis.summary.byType.forEach(({ type, count, estimatedTokens, avgTokensPerFile }) => {
        if (count > 0) {
          console.log(`   ${type.charAt(0).toUpperCase() + type.slice(1)}: ${count} files (~${estimatedTokens.toLocaleString()} tokens, avg ${avgTokensPerFile}/file)`);
        }
      });
      console.log('');
    }
  }
}