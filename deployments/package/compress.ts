import { MultiCloudConfig } from "../shared.ts";
import fs from "fs/promises";
import path from "path";
import archiver from "archiver";
import { createWriteStream } from "fs";

export async function zipFunctions(
  functions: MultiCloudConfig["functions"],
  outDir: string,
  apiSuffix: string = "",
  removeBuildDir: boolean = true,
  additionalFiles: string[] = []
): Promise<void> {
  for (const func of functions) {
    const functionName = func.name + apiSuffix;
    const buildPath = path.join(outDir, functionName);
    const zipPath = path.join(outDir, `${functionName}.zip`);

    // Check if build output exists and what type it is
    let buildStat;
    try {
      buildStat = await fs.stat(buildPath);
    } catch (error) {
      // Try with .js extension if the bare name doesn't exist
      const jsPath = buildPath + ".js";
      try {
        buildStat = await fs.stat(jsPath);
        // Update buildPath to the actual file
        const actualBuildPath = jsPath;
        await createZipFromFile(actualBuildPath, zipPath, additionalFiles);

        if (removeBuildDir) {
          await fs.rm(actualBuildPath, { force: true });
        }

        console.log(`📦 Packaged ${func.name} → ${zipPath}`);
        continue;
      } catch {
        throw new Error(
          `Build output not found for ${func.name} at ${buildPath} or ${jsPath}`
        );
      }
    }

    if (buildStat.isFile()) {
      // Single file output
      await createZipFromFile(buildPath, zipPath, additionalFiles);
    } else if (buildStat.isDirectory()) {
      // Directory output
      await createZipFromDirectory(buildPath, zipPath, additionalFiles);
    } else {
      throw new Error(`Unexpected build output type for ${func.name}`);
    }

    // Remove the build output
    if (removeBuildDir) {
      await fs.rm(buildPath, { recursive: true, force: true });
    }

    console.log(`📦 Packaged ${func.name} → ${zipPath}`);
  }
}

// Updated helper functions to handle additional files:

async function createZipFromFile(
  filePath: string,
  zipPath: string,
  additionalFiles: string[] = []
): Promise<void> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = createWriteStream(zipPath);

  archive.pipe(output);

  // Add the main function file
  archive.file(filePath, { name: path.basename(filePath) });

  // Add additional files (layers) with just filename
  for (const additionalFile of additionalFiles) {
    try {
      const fileName = path.basename(additionalFile);
      archive.file(additionalFile, { name: fileName });
      console.log(`  ➕ Added layer: ${fileName}`);
    } catch (error) {
      console.warn(
        `  ⚠️  Failed to add additional file ${additionalFile}:`,
        error
      );
    }
  }

  await archive.finalize();

  return new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
  });
}

async function createZipFromDirectory(
  dirPath: string,
  zipPath: string,
  additionalFiles: string[] = []
): Promise<void> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = createWriteStream(zipPath);

  archive.pipe(output);

  // Add the entire directory
  archive.directory(dirPath, false);

  // Add additional files (layers) with just filename
  for (const additionalFile of additionalFiles) {
    try {
      const fileName = path.basename(additionalFile);
      archive.file(additionalFile, { name: fileName });
      console.log(`  ➕ Added layer: ${fileName}`);
    } catch (error) {
      console.warn(
        `  ⚠️  Failed to add additional file ${additionalFile}:`,
        error
      );
    }
  }

  await archive.finalize();

  return new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
  });
}

export async function zipSinglePackage(
  functions: MultiCloudConfig["functions"],
  outDir: string,
  packageName: string,
  rootSrc: string,
  apiSuffix: string = "",
  additionalFiles: string[] = [],
  additionalContent: Array<{ content: string; name: string }> = [],
  removeBuildDir: boolean = true
): Promise<void> {
  const zipPath = path.join(outDir, `${packageName}.zip`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = createWriteStream(zipPath);
  archive.pipe(output);

  // Add each compiled function at root level
  for (const func of functions) {
    const functionName = func.name + apiSuffix;
    const buildPath = path.join(rootSrc, functionName);

    // Check if build output exists and what type it is
    let buildStat;
    try {
      buildStat = await fs.stat(buildPath);
    } catch (error) {
      // Try with common extensions if the bare name doesn't exist
      const extensions = [".js", ".pyz"];
      let found = false;

      for (const ext of extensions) {
        const pathWithExt = buildPath + ext;
        try {
          buildStat = await fs.stat(pathWithExt);
          archive.file(pathWithExt, { name: functionName });
          console.log(`  ➕ Added function: ${func.name}`);
          found = true;
          break;
        } catch {
          // Try next extension
        }
      }

      if (!found) {
        throw new Error(
          `Build output not found for ${func.name} at ${buildPath}, ${buildPath}.js, or ${buildPath}.pyz`
        );
      }
      continue;
    }

    if (buildStat.isFile()) {
      // Single file output
      archive.file(buildPath, { name: functionName });
    } else if (buildStat.isDirectory()) {
      // Directory output - add contents to root
      archive.directory(buildPath, functionName);
    } else {
      throw new Error(`Unexpected build output type for ${func.name}`);
    }

    console.log(`  ➕ Added function: ${func.name}`);
  }

  // Add additional file paths (layers)
  for (const additionalFile of additionalFiles) {
    try {
      const fileName = path.basename(additionalFile);
      archive.file(additionalFile, { name: fileName });
      console.log(`  ➕ Added layer: ${fileName}`);
    } catch (error) {
      console.warn(
        `  ⚠️  Failed to add additional file ${additionalFile}:`,
        error
      );
    }
  }

  // Add additional content (strings as files)
  for (const content of additionalContent) {
    archive.append(content.content, { name: content.name });
  }

  await archive.finalize();

  await new Promise((resolve, reject) => {
    output.on("close", () => {
      console.log(
        `✅ Package created: ${zipPath} (${archive.pointer()} bytes)`
      );
      resolve(undefined);
    });
    output.on("error", reject);
  });

  // Remove build outputs if requested
  if (removeBuildDir) {
    for (const func of functions) {
      const functionName = func.name + apiSuffix;
      const buildPath = path.join(outDir, functionName);
      try {
        await fs.rm(buildPath, { recursive: true, force: true });
      } catch {
        // Try removing files with common extensions
        const extensions = [".js", ".pyz"];
        for (const ext of extensions) {
          try {
            await fs.rm(buildPath + ext, { force: true });
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }
  }
}

export async function zipDirectoryAsIs(
  sourcePath: string,
  outDir: string,
  packageName: string,
  additionalFiles: string[] = [],
  additionalContent: Array<{ content: string; name: string }> = []
): Promise<void> {
  const zipPath = path.join(outDir, `${packageName}.zip`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = createWriteStream(zipPath);
  archive.pipe(output);

  // Check if source path exists and what type it is
  let sourceStat;
  try {
    sourceStat = await fs.stat(sourcePath);
  } catch (error) {
    throw new Error(`Source path not found: ${sourcePath}`);
  }

  if (sourceStat.isFile()) {
    // Single file - add to root of zip
    const fileName = path.basename(sourcePath);
    archive.file(sourcePath, { name: fileName });
    console.log(`  ➕ Added file: ${fileName}`);
  } else if (sourceStat.isDirectory()) {
    // Directory - preserve structure but use packageName as root folder
    archive.directory(sourcePath, false); // Use packageName as the root folder in zip
    console.log(`  ➕ Added directory contents: ${sourcePath}/`);
  } else {
    throw new Error(`Unexpected source type for ${sourcePath}`);
  }

  // Add additional file paths
  for (const additionalFile of additionalFiles) {
    try {
      const fileName = path.basename(additionalFile);
      const additionalStat = await fs.stat(additionalFile);

      if (additionalStat.isFile()) {
        archive.file(additionalFile, { name: fileName });
        console.log(`  ➕ Added additional file: ${fileName}`);
      } else if (additionalStat.isDirectory()) {
        archive.directory(additionalFile, fileName); // Keep directory structure for additional dirs
        console.log(`  ➕ Added additional directory: ${fileName}`);
      }
    } catch (error) {
      console.warn(
        `  ⚠️  Failed to add additional file ${additionalFile}:`,
        error
      );
    }
  }

  // Add additional content (strings as files)
  for (const content of additionalContent) {
    archive.append(content.content, { name: content.name });
    console.log(`  ➕ Added content file: ${content.name}`);
  }

  await archive.finalize();

  await new Promise((resolve, reject) => {
    output.on("close", () => {
      console.log(
        `✅ Package created: ${zipPath} (${archive.pointer()} bytes)`
      );
      resolve(undefined);
    });
    output.on("error", reject);
  });
}
