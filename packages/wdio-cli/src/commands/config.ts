import fs from 'node:fs/promises'
import path from 'node:path'

import inquirer from 'inquirer'
import type { Argv } from 'yargs'

import {
    CONFIG_HELPER_INTRO, CLI_EPILOGUE, CompilerOptions, SUPPORTED_PACKAGES,
    configHelperSuccessMessage, isNuxtProject, SUPPORTED_CONFIG_FILE_EXTENSION, CONFIG_HELPER_SERENITY_BANNER,
} from '../constants.js'
import {
    convertPackageHashToObject, getAnswers, getPathForFileGeneration, getProjectProps,
    getProjectRoot, createPackageJSON, setupTypeScript, setupBabel, npmInstall,
    createWDIOConfig, createWDIOScript, runAppiumInstaller, getSerenityPackages
} from '../utils.js'
import type { ConfigCommandArguments, ParsedAnswers } from '../types.js'

const hasYarnLock = await fs.access('yarn.lock').then(() => true, () => false)

export const command = 'config'
export const desc = 'Initialize WebdriverIO and setup configuration in your current project.'

export const cmdArgs = {
    yarn: {
        type: 'boolean',
        desc: 'Install packages via Yarn package manager.',
        default: hasYarnLock
    },
    yes: {
        alias: 'y',
        desc: 'will fill in all config defaults without prompting',
        type: 'boolean',
        default: false
    },
    npmTag: {
        alias: 't',
        desc: 'define NPM tag to use for WebdriverIO related packages',
        type: 'string',
        default: 'latest'
    }
} as const

export const builder = (yargs: Argv) => {
    return yargs
        .options(cmdArgs)
        .epilogue(CLI_EPILOGUE)
        .help()
}

export const parseAnswers = async function (yes: boolean): Promise<ParsedAnswers> {
    console.log(CONFIG_HELPER_INTRO)
    const answers = await getAnswers(yes)
    const frameworkPackage = convertPackageHashToObject(answers.framework)
    const runnerPackage = convertPackageHashToObject(answers.runner || SUPPORTED_PACKAGES.runner[0].value)
    const servicePackages = answers.services.map((service) => convertPackageHashToObject(service))
    const pluginPackages = answers.plugins.map((plugin) => convertPackageHashToObject(plugin))
    const serenityPackages = getSerenityPackages(answers)
    const reporterPackages = answers.reporters.map((reporter) => convertPackageHashToObject(reporter))
    const presetPackage = convertPackageHashToObject(answers.preset || '')
    const projectProps = await getProjectProps(process.cwd())
    const projectRootDir = getProjectRoot(answers, projectProps)

    const packagesToInstall: string[] = [
        runnerPackage.package,
        frameworkPackage.package,
        presetPackage.package,
        ...reporterPackages.map(reporter => reporter.package),
        ...pluginPackages.map(plugin => plugin.package),
        ...servicePackages.map(service => service.package),
        ...serenityPackages,
    ].filter(Boolean)

    /**
     * find relative paths between tests and pages
     */
    const hasRootTSConfig = await fs.access(path.resolve(projectRootDir, 'tsconfig.json')).then(() => true, () => false)
    const tsConfigFilePath = !hasRootTSConfig
        /**
         * if no tsconfig.json exists in project, create one
         */
        ? path.resolve(projectRootDir, 'tsconfig.json')
        /**
         * otherwise make it dependent on whether the user wants to autogenerate files
         */
        : answers.specs
            /**
             * if we have autogenerated spec files, put the tsconfig one above the spec file dir
             */
            ? path.resolve(
                path.dirname(answers.specs.split(path.sep).filter((s) => !s.includes('*')).join(path.sep)),
                'tsconfig.json'
            )
            /**
             * if no spec files are auto generated, create a wdio tsconfig and let the user deal with it
             */
            : path.resolve(projectRootDir, `tsconfig.${runnerPackage.short === 'local' ? 'e2e' : 'wdio'}.json`)
    const parsedPaths = getPathForFileGeneration(answers, projectRootDir)
    const isUsingTypeScript = answers.isUsingCompiler === CompilerOptions.TS
    const wdioConfigFilename = `wdio.conf.${isUsingTypeScript ? 'ts' : 'js'}`
    const wdioConfigPath = path.resolve(projectRootDir, wdioConfigFilename)

    return {
        projectName: projectProps?.packageJson.name || 'Test Suite',
        // default values required in templates
        ...({
            usePageObjects: false,
            installTestingLibrary: false
        }),
        ...answers,
        useSauceConnect: isNuxtProject || answers.useSauceConnect,
        rawAnswers: answers,
        runner: runnerPackage.short as 'local' | 'browser',
        preset: presetPackage.short,
        framework: frameworkPackage.short,
        purpose: runnerPackage.purpose,
        serenityAdapter: frameworkPackage.package === '@serenity-js/webdriverio' && frameworkPackage.purpose,
        reporters: reporterPackages.map(({ short }) => short),
        plugins: pluginPackages.map(({ short }) => short),
        services: servicePackages.map(({ short }) => short),
        specs: answers.specs && `./${path.relative(projectRootDir, answers.specs).replaceAll(path.sep, '/')}`,
        stepDefinitions: answers.stepDefinitions && `./${path.relative(projectRootDir, answers.stepDefinitions).replaceAll(path.sep, '/')}`,
        packagesToInstall,
        isUsingTypeScript,
        isUsingBabel: answers.isUsingCompiler === CompilerOptions.Babel,
        esmSupport: projectProps && !(projectProps.esmSupported) ? false : true,
        isSync: false,
        _async: 'async ',
        _await: 'await ',
        projectRootDir,
        destSpecRootPath: parsedPaths.destSpecRootPath,
        destStepRootPath: parsedPaths.destStepRootPath,
        destPageObjectRootPath: parsedPaths.destPageObjectRootPath,
        destSerenityLibRootPath: parsedPaths.destSerenityLibRootPath,
        relativePath: parsedPaths.relativePath,
        hasRootTSConfig,
        tsConfigFilePath,
        tsProject: `./${path.relative(projectRootDir, tsConfigFilePath).replaceAll(path.sep, '/')}`,
        wdioConfigPath
    }
}

export async function runConfigCommand(parsedAnswers: ParsedAnswers, useYarn: boolean, npmTag: string) {
    console.log('\n')

    await createPackageJSON(parsedAnswers)
    await setupTypeScript(parsedAnswers)
    await setupBabel(parsedAnswers)
    await npmInstall(parsedAnswers, useYarn, npmTag)
    await createWDIOConfig(parsedAnswers)
    await createWDIOScript(parsedAnswers)

    /**
     * print success message
     */
    console.log(
        configHelperSuccessMessage({
            projectRootDir: parsedAnswers.projectRootDir,
            runScript: parsedAnswers.serenityAdapter ? 'serenity' : 'wdio',
            extraInfo: parsedAnswers.serenityAdapter ? CONFIG_HELPER_SERENITY_BANNER : ''
        }),
    )

    await runAppiumInstaller(parsedAnswers)
}

export async function handler(argv: ConfigCommandArguments, runConfigCmd = runConfigCommand) {
    const parsedAnswers = await parseAnswers(argv.yes)
    await runConfigCmd(parsedAnswers, argv.yarn, argv.npmTag)
    return {
        success: true,
        parsedAnswers,
        installedPackages: parsedAnswers.packagesToInstall.map((pkg) => pkg.split('--')[0])
    }
}

/**
 * Helper utility used in `run` and `install` command to format a provided config path,
 * giving it back as an absolute path, and a version without the file extension
 * @param config the initially given file path to the WDIO config file
 */
export async function formatConfigFilePaths(config: string) {
    const fullPath = path.isAbsolute(config)
        ? config
        : path.join(process.cwd(), config)
    const fullPathNoExtension = fullPath.substring(0, fullPath.lastIndexOf(path.extname(fullPath)))
    return { fullPath, fullPathNoExtension }
}

/**
 * Helper utility used in `run` and `install` command to check whether a config file currently exists
 * @param configPath the file path to the WDIO config file
 * @returns {string} the path to the config file that exists, otherwise undefined
 */
export async function canAccessConfigPath(configPath: string) {
    return Promise.all(SUPPORTED_CONFIG_FILE_EXTENSION.map(async (supportedExtension) => {
        const configPathWithExtension = `${configPath}.${supportedExtension}`
        return fs.access(configPathWithExtension).then(() => configPathWithExtension, () => undefined)
    })).then(
        (configFilePaths) => configFilePaths.find(Boolean),
        () => undefined
    )
}

/**
 * Helper utility used in `run` and `install` command to create config if none exist
 * @param {string}   command        to be executed by user
 * @param {string}   configPath     the path to a wdio.conf.[js/ts] file
 * @param {boolean}  useYarn        parameter set to true if yarn is used
 * @param {Function} runConfigCmd   runConfig method to be replaceable for unit testing
 */
export async function missingConfigurationPrompt(command: string, configPath: string, useYarn = false, runConfigCmd = runConfigCommand) {

    const message = (
        `Could not execute "${command}" due to missing configuration, file ` +
        `"${path.parse(configPath).name}[.js/.ts]" not found! ` +
        'Would you like to create one?'
    )

    const { config } = await inquirer.prompt([{
        type: 'confirm',
        name: 'config',
        message: message,
        default: false
    }])

    /**
     * don't exit if running unit tests
     */
    if (!config) {
        /* istanbul ignore next */
        console.log(`No WebdriverIO configuration found in "${process.cwd()}"`)

        /* istanbul ignore next */
        return !process.env.VITEST_WORKER_ID && process.exit(0)
    }

    const parsedAnswers = await parseAnswers(false)
    await runConfigCmd(parsedAnswers, useYarn, 'latest')
}
