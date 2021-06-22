import path from 'path'
import * as fs from 'fs'
import * as config from './config'
import {ExecFunction} from './exec'
import {getAbsolutePath} from './file'
import {substituteValues} from './envvars'

export async function isDockerBuildXInstalled(exec: ExecFunction): Promise<boolean> {
	const exitCode = await exec('docker', ['buildx', '--help'])
	return exitCode === 0
}
export async function buildImage(
	exec: ExecFunction,
	imageName: string,
	checkoutPath: string,
	subFolder: string
): Promise<void> {
	const folder = path.join(checkoutPath, subFolder)

	const devcontainerJsonPath = path.join(
		folder,
		'.devcontainer/devcontainer.json'
	)
	const devcontainerConfig = await config.loadFromFile(devcontainerJsonPath)

	const configDockerfile = config.getDockerfile(devcontainerConfig)
	if (!configDockerfile) {
		throw new Error(
			'dockerfile not set in devcontainer.json - devcontainer-build-run currently only supports Dockerfile-based dev containers'
		)
	}
	const dockerfilePath = path.join(folder, '.devcontainer', configDockerfile)

	const configContext = config.getContext(devcontainerConfig) ?? ''
	const contextPath = path.join(folder, '.devcontainer', configContext)

	const args = ['buildx', 'build']
	args.push('--tag')
	args.push(`${imageName}:latest`)
	args.push('--cache-from')
	args.push(`type=registry,ref=${imageName}:latest`)
	args.push('--cache-to')
	args.push('type=inline')
	args.push('--output=type=docker')

	const buildArgs = devcontainerConfig.build?.args
	for (const argName in buildArgs) {
		const argValue = substituteValues(buildArgs[argName])
		args.push('--build-arg', `${argName}=${argValue}`)
	}

	args.push('-f', dockerfilePath)
	args.push(contextPath)

	// TODO - add abstraction to allow startGroup on GH actions
	// core.startGroup('🏗 Building dev container...')
	try {
		const exitCode = await exec('docker', args)

		if (exitCode !== 0) {
			throw new Error(`build failed with ${exitCode}`)
		}
	} finally {
		// core.endGroup() // TODO
	}
}

export async function runContainer(
	exec: ExecFunction,
	imageName: string,
	checkoutPath: string,
	subFolder: string,
	command: string,
	envs?: string[],
	mounts?: string[]
): Promise<void> {
	const checkoutPathAbsolute = getAbsolutePath(checkoutPath, process.cwd())
	const folder = path.join(checkoutPathAbsolute, subFolder)

	const devcontainerJsonPath = path.join(
		folder,
		'.devcontainer/devcontainer.json'
	)
	const devcontainerConfig = await config.loadFromFile(devcontainerJsonPath)

	const workspaceFolder = config.getWorkspaceFolder(devcontainerConfig, folder)
	const remoteUser = config.getRemoteUser(devcontainerConfig)

	const args = ['run']
	args.push(
		'--mount',
		`type=bind,src=${checkoutPathAbsolute},dst=${workspaceFolder}`
	)
	if (devcontainerConfig.mounts) {
		devcontainerConfig.mounts
			.map(m => substituteValues(m))
			.forEach(m => {
				const mount = parseMount(m)
				if (mount.type === "bind") {
					// check path exists
					if (!fs.existsSync(mount.source)) {
						console.log(`Skipping mount as source does not exist: '${m}'`)
						return;
					}
				}
				args.push('--mount', m)
			});
	}
	args.push('--workdir', workspaceFolder)
	args.push('--user', remoteUser)
	if (devcontainerConfig.runArgs) {
		const substitutedRunArgs = devcontainerConfig.runArgs.map(a =>
			substituteValues(a)
		)
		args.push(...substitutedRunArgs)
	}
	if (envs) {
		for (const env of envs) {
			args.push('--env', env)
		}
	}
	args.push(`${imageName}:latest`)
	args.push('bash', '-c', `sudo chown -R $(whoami) . && ${command}`) // TODO sort out permissions/user alignment

	// core.startGroup('🏃‍♀️ Running dev container...')
	try {
		const exitCode = await exec('docker', args)

		if (exitCode !== 0) {
			throw new Error(`run failed with ${exitCode}`)
		}
	} finally {
		// core.endGroup()
	}
}

export async function pushImage(exec: ExecFunction, imageName: string): Promise<void> {
	const args = ['push']
	args.push(`${imageName}:latest`)

	// core.startGroup('Pushing image...')
	try {
		const exitCode = await exec('docker', args)

		if (exitCode !== 0) {
			throw new Error(`push failed with ${exitCode}`)
		}
	} finally {
		// core.endGroup()
	}
}

export interface DockerMount {
	type: string,
	source: string,
	target: string,
	// ignoring readonly as not relevant
}

export function parseMount(mountString: string): DockerMount {
	// https://docs.docker.com/engine/reference/commandline/service_create/#add-bind-mounts-volumes-or-memory-filesystems
	// examples:
	//		type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock
	//		src=home-cache,target=/home/vscode/.cache

	let type = ''
	let source = ''
	let target = ''

	const options= mountString.split(',')
	
	for (const option of options) {
		const parts = option.split('=');
		
		switch (parts[0]) {
			case 'type':
				type = parts[1]
				break;
			case 'src':
			case 'source':
				source = parts[1]
				break;
			case 'dst':
			case 'destination':
			case 'target':
				target = parts[1]
				break;

			case 'readonly':
			case 'ro':
				// ignore
				break;

			default:
				throw new Error(`Unhandled mount option '${parts[0]}'`);
		}
	}

	return {type, source, target}
}